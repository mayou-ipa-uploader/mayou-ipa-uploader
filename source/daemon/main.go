package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type ProxyConfig struct {
	Enabled  bool   `json:"enabled"`
	Type     string `json:"type"`
	Host     string `json:"host"`
	Port     string `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
}

type FingerprintConfig struct {
	OS                  string `json:"os"`
	KernelVersion       string `json:"kernelVersion"`
	BrowserVersion      string `json:"browserVersion"`
	WindowsVersion      string `json:"windowsVersion"`
	DeviceName          string `json:"deviceName"`
	HostIP              string `json:"hostIp"`
	MACAddress          string `json:"macAddress"`
	PortScanProtection  *bool  `json:"portScanProtection"`
	UserAgent           string `json:"userAgent"`
	Platform            string `json:"platform"`
	Vendor              string `json:"vendor"`
	Language            string `json:"language"`
	Languages           string `json:"languages"`
	LanguageFollowIP    *bool  `json:"languageFollowIP"`
	UILanguageFollowIP  *bool  `json:"uiLanguageFollowIP"`
	UILanguage          string `json:"uiLanguage"`
	GeoPermission       string `json:"geoPermission"`
	GeolocationFollowIP *bool  `json:"geolocationFollowIP"`
	GeoLatitude         any    `json:"geoLatitude"`
	GeoLongitude        any    `json:"geoLongitude"`
	GeoAccuracy         any    `json:"geoAccuracy"`
	Timezone            string `json:"timezone"`
	ScreenWidth         int    `json:"screenWidth"`
	ScreenHeight        int    `json:"screenHeight"`
	ColorDepth          int    `json:"colorDepth"`
	HardwareConcurrency int    `json:"hardwareConcurrency"`
	DeviceMemory        int    `json:"deviceMemory"`
	WebGLVendor         string `json:"webglVendor"`
	WebGLRenderer       string `json:"webglRenderer"`
	CanvasNoise         string `json:"canvasNoise"`
}

type IPGuardConfig struct {
	Enabled    bool   `json:"enabled"`
	ExpectedIP string `json:"expectedIP"`
}

type Environment struct {
	ID          string            `json:"id"`
	SerialNum   string            `json:"serialNum"`
	Name        string            `json:"name"`
	Note        string            `json:"note"`
	HomeURL     string            `json:"homeUrl"`
	DebugPort   int               `json:"debugPort"`
	Proxy       ProxyConfig       `json:"proxy"`
	IPGuard     IPGuardConfig     `json:"ipGuard"`
	Fingerprint FingerprintConfig `json:"fingerprint"`
	CreatedAt   string            `json:"createdAt"`
}

type OpenBrowserRequest struct {
	EnvironmentID string `json:"environmentId"`
}

type Store struct {
	mu           sync.Mutex
	path         string
	environments []Environment
	processes    map[string]*exec.Cmd
	debugPorts   map[string]int // envId -> CDP debug port

	tunnelMu sync.Mutex
	tunnels  map[string]*proxyTunnel // envId -> tunnel
}

type proxyTunnel struct {
	envID     string
	listener  net.Listener
	localPort int
	proxy     ProxyConfig
	cancel    chan struct{}
}

// ========== SOCKS5 Client (minimal, no external deps) ==========

func socks5Dial(proxy ProxyConfig, targetHost string, targetPort int) (net.Conn, error) {
	addr := net.JoinHostPort(proxy.Host, proxy.Port)
	conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		return nil, fmt.Errorf("socks5 connect: %w", err)
	}

	// Handshake: offer username/password auth (0x02)
	_, err = conn.Write([]byte{0x05, 0x01, 0x02})
	if err != nil {
		conn.Close()
		return nil, err
	}

	resp := make([]byte, 2)
	if _, err := io.ReadFull(conn, resp); err != nil {
		conn.Close()
		return nil, err
	}
	if resp[0] != 0x05 || resp[1] != 0x02 {
		conn.Close()
		return nil, fmt.Errorf("socks5: server did not accept auth method (got %02x %02x)", resp[0], resp[1])
	}

	// Username/password auth
	user, pass := proxy.Username, proxy.Password
	authMsg := []byte{0x01, byte(len(user))}
	authMsg = append(authMsg, []byte(user)...)
	authMsg = append(authMsg, byte(len(pass)))
	authMsg = append(authMsg, []byte(pass)...)
	if _, err := conn.Write(authMsg); err != nil {
		conn.Close()
		return nil, err
	}

	authResp := make([]byte, 2)
	if _, err := io.ReadFull(conn, authResp); err != nil {
		conn.Close()
		return nil, err
	}
	if authResp[1] != 0x00 {
		conn.Close()
		return nil, fmt.Errorf("socks5: authentication failed")
	}

	// CONNECT request (domain name = 0x03)
	req := []byte{0x05, 0x01, 0x00, 0x03, byte(len(targetHost))}
	req = append(req, []byte(targetHost)...)
	req = append(req, byte(targetPort>>8), byte(targetPort&0xff))
	if _, err := conn.Write(req); err != nil {
		conn.Close()
		return nil, err
	}

	// Read CONNECT response (variable length)
	connectResp := make([]byte, 4)
	if _, err := io.ReadFull(conn, connectResp); err != nil {
		conn.Close()
		return nil, err
	}
	if connectResp[1] != 0x00 {
		conn.Close()
		return nil, fmt.Errorf("socks5: connect failed, code=%d", connectResp[1])
	}

	// Skip bound address (variable length based on address type)
	switch connectResp[3] {
	case 0x01: // IPv4: 4 bytes addr + 2 bytes port
		if _, err := io.ReadFull(conn, make([]byte, 6)); err != nil {
			conn.Close()
			return nil, err
		}
	case 0x03: // Domain: 1 byte len + len bytes + 2 bytes port
		lenBuf := make([]byte, 1)
		if _, err := io.ReadFull(conn, lenBuf); err != nil {
			conn.Close()
			return nil, err
		}
		if _, err := io.ReadFull(conn, make([]byte, int(lenBuf[0])+2)); err != nil {
			conn.Close()
			return nil, err
		}
	case 0x04: // IPv6: 16 bytes addr + 2 bytes port
		if _, err := io.ReadFull(conn, make([]byte, 18)); err != nil {
			conn.Close()
			return nil, err
		}
	}

	return conn, nil
}

// ========== HTTP CONNECT Tunnel ==========

func startProxyTunnel(proxy ProxyConfig) (*proxyTunnel, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}

	t := &proxyTunnel{
		listener:  listener,
		localPort: listener.Addr().(*net.TCPAddr).Port,
		proxy:     proxy,
		cancel:    make(chan struct{}),
	}

	go func() {
		for {
			select {
			case <-t.cancel:
				return
			default:
			}

			conn, err := listener.Accept()
			if err != nil {
				select {
				case <-t.cancel:
					return
				default:
				}
				continue
			}
			go handleHTTPConnect(conn, proxy)
		}
	}()

	return t, nil
}

func handleHTTPConnect(clientConn net.Conn, proxy ProxyConfig) {
	defer clientConn.Close()

	// Read the full HTTP request
	var buf bytes.Buffer
	tmp := make([]byte, 4096)
	headerEnd := -1
	for {
		n, err := clientConn.Read(tmp)
		if err != nil || n == 0 {
			return
		}
		buf.Write(tmp[:n])
		// Look for end of headers (\r\n\r\n)
		idx := bytes.Index(buf.Bytes(), []byte("\r\n\r\n"))
		if idx >= 0 {
			headerEnd = idx + 4
			break
		}
	}

	rawData := buf.Bytes()
	headersBlock := rawData[:headerEnd]
	bodyBlock := rawData[headerEnd:]
	headerStr := string(headersBlock)
	lines := strings.SplitN(headerStr, "\r\n", 2)
	firstLine := lines[0]
	rest := ""
	if len(lines) > 1 {
		rest = lines[1]
	}

	parts := strings.Fields(firstLine)
	if len(parts) < 2 {
		return
	}
	method := strings.ToUpper(parts[0])
	target := parts[1]

	if method == "CONNECT" {
		host, portStr, err := net.SplitHostPort(target)
		if err != nil {
			return
		}
		port, _ := strconv.Atoi(portStr)
		targetConn, err := socks5Dial(proxy, host, port)
		if err != nil {
			clientConn.Write([]byte("HTTP/1.1 502 Bad Gateway\r\n\r\n"))
			return
		}
		defer targetConn.Close()
		clientConn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))
		relay(clientConn, targetConn)
		return
	}

	// Regular HTTP proxy: parse absolute URL, dial via SOCKS5, forward rewritten request
	raw := target
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	schemeEnd := strings.Index(raw, "://")
	scheme := raw[:schemeEnd]
	restURL := raw[schemeEnd+3:]
	pathStart := strings.Index(restURL, "/")
	hostPort := restURL
	if pathStart >= 0 {
		hostPort = restURL[:pathStart]
	}
	host, portStr, _ := net.SplitHostPort(hostPort)
	if portStr == "" {
		if scheme == "https" {
			portStr = "443"
		} else {
			portStr = "80"
		}
		host = hostPort
	}
	portNum, _ := strconv.Atoi(portStr)

	targetConn, err := socks5Dial(proxy, host, portNum)
	if err != nil {
		clientConn.Write([]byte("HTTP/1.1 502 Bad Gateway\r\n\r\n"))
		return
	}
	defer targetConn.Close()

	// Rewrite first line: absolute URL -> relative path
	pathOnly := "/"
	if pathStart >= 0 {
		pathOnly = restURL[pathStart:]
	}
	newFirstLine := method + " " + pathOnly + " HTTP/1.1\r\n"

	var forwardBuf bytes.Buffer
	forwardBuf.WriteString(newFirstLine)
	forwardBuf.WriteString(rest)
	forwardBuf.WriteString("\r\n") // end headers
	forwardBuf.Write(bodyBlock)

	if _, err := targetConn.Write(forwardBuf.Bytes()); err != nil {
		return
	}
	relay(clientConn, targetConn)
}

func relay(a, b net.Conn) {
	done := make(chan struct{}, 2)
	go func() { io.Copy(b, a); done <- struct{}{} }()
	go func() { io.Copy(a, b); done <- struct{}{} }()
	<-done
	<-done
}

func (t *proxyTunnel) stop() {
	close(t.cancel)
	t.listener.Close()
}

func main() {
	store, err := NewStore(defaultDataPath())
	if err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	mux.HandleFunc("GET /browser-core/status", browserCoreStatus)
	mux.HandleFunc("POST /proxy/detect", handleProxyDetect)
	mux.HandleFunc("POST /proxy/tunnel/open", store.openTunnel)
	mux.HandleFunc("POST /proxy/tunnel/close", store.closeTunnel)
	mux.HandleFunc("GET /environments", store.listEnvironments)
	mux.HandleFunc("POST /environments", store.createEnvironment)
	mux.HandleFunc("PUT /environments/{id}", store.updateEnvironment)
	mux.HandleFunc("DELETE /environments/{id}", store.deleteEnvironment)
	mux.HandleFunc("POST /browser/open", store.openBrowser)
	mux.HandleFunc("POST /browser/close", store.closeBrowser)
	mux.HandleFunc("POST /browser/debug/register", store.registerDebugPort)
	mux.HandleFunc("POST /browser/debug/unregister", store.unregisterDebugPort)
	mux.HandleFunc("GET /browser/debug/list", store.listDebugPorts)
	mux.HandleFunc("GET /browser/debug/{id}", store.getDebugPort)

	addr := os.Getenv("IPAUPLOADER_DAEMON_ADDR")
	if addr == "" {
		addr = "127.0.0.1:54346"
	}
	log.Printf("daemon listening on http://%s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}

func browserCoreStatus(w http.ResponseWriter, r *http.Request) {
	path := browserCorePath()
	cmd := exec.Command(path, "--version-json")
	output, err := cmd.Output()
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"available": false,
			"path":      path,
			"error":     err.Error(),
		})
		return
	}
	output = bytes.TrimSpace(output)
	var body map[string]any
	if err := json.Unmarshal(output, &body); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"available": false,
			"path":      path,
			"error":     "invalid browser-core status JSON",
			"raw":       string(output),
		})
		return
	}
	body["available"] = true
	body["path"] = path
	writeJSON(w, http.StatusOK, body)
}

func NewStore(path string) (*Store, error) {
	store := &Store{path: path, processes: map[string]*exec.Cmd{}, debugPorts: map[string]int{}, tunnels: map[string]*proxyTunnel{}}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		store.environments = []Environment{}
		return store, store.save()
	}
	if err != nil {
		return nil, err
	}
	if len(data) > 0 {
		if err := json.Unmarshal(data, &store.environments); err != nil {
			return nil, err
		}
	}
	return store, nil
}

func (s *Store) listEnvironments(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	writeJSON(w, http.StatusOK, s.environments)
}

func (s *Store) createEnvironment(w http.ResponseWriter, r *http.Request) {
	var env Environment
	if err := json.NewDecoder(r.Body).Decode(&env); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if env.Name == "" {
		env.Name = "New Environment"
	}
	env.ID = randomID()
	env.CreatedAt = time.Now().Format(time.RFC3339)

	s.mu.Lock()
	defer s.mu.Unlock()
	s.environments = append(s.environments, env)
	if err := s.save(); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, env)
}

func (s *Store) openBrowser(w http.ResponseWriter, r *http.Request) {
	var req OpenBrowserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}

	s.mu.Lock()
	env, ok := s.findEnvironment(req.EnvironmentID)
	if !ok {
		s.mu.Unlock()
		writeError(w, http.StatusNotFound, "environment not found")
		return
	}
	if _, running := s.processes[env.ID]; running {
		s.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"running": true})
		return
	}
	s.mu.Unlock()

	cmd := exec.Command(browserCorePath(), browserArgs(env)...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	s.mu.Lock()
	s.processes[env.ID] = cmd
	s.mu.Unlock()

	go func() {
		_ = cmd.Wait()
		s.mu.Lock()
		delete(s.processes, env.ID)
		s.mu.Unlock()
	}()

	writeJSON(w, http.StatusOK, map[string]any{"running": true, "pid": cmd.Process.Pid})
}

func (s *Store) closeBrowser(w http.ResponseWriter, r *http.Request) {
	var req OpenBrowserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	s.mu.Lock()
	cmd := s.processes[req.EnvironmentID]
	delete(s.processes, req.EnvironmentID)
	delete(s.debugPorts, req.EnvironmentID)
	s.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
	// Auto-cleanup tunnel
	s.stopTunnel(req.EnvironmentID)
	writeJSON(w, http.StatusOK, map[string]any{"running": false})
}

// ---------- Debug Port (CDP) handlers for Python automation ----------

type DebugRegisterRequest struct {
	EnvironmentID string `json:"environmentId"`
	DebugPort     int    `json:"debugPort"`
}

func (s *Store) registerDebugPort(w http.ResponseWriter, r *http.Request) {
	var req DebugRegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	s.mu.Lock()
	s.debugPorts[req.EnvironmentID] = req.DebugPort
	s.mu.Unlock()
	log.Printf("[debug] registered port %d for env %s", req.DebugPort, req.EnvironmentID)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Store) unregisterDebugPort(w http.ResponseWriter, r *http.Request) {
	var req DebugRegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	s.mu.Lock()
	delete(s.debugPorts, req.EnvironmentID)
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Store) getDebugPort(w http.ResponseWriter, r *http.Request) {
	envID := r.PathValue("id")
	s.mu.Lock()
	port, ok := s.debugPorts[envID]
	s.mu.Unlock()
	if !ok {
		writeError(w, http.StatusNotFound, "debug port not found for this environment")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"environmentId": envID,
		"debugPort":     port,
		"cdpURL":        fmt.Sprintf("http://127.0.0.1:%d", port),
		"wsEndpoint":    fmt.Sprintf("ws://127.0.0.1:%d", port),
	})
}

func (s *Store) listDebugPorts(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	results := make([]map[string]any, 0, len(s.debugPorts))
	for envID, port := range s.debugPorts {
		results = append(results, map[string]any{
			"environmentId": envID,
			"debugPort":     port,
			"cdpURL":        fmt.Sprintf("http://127.0.0.1:%d", port),
		})
	}
	writeJSON(w, http.StatusOK, results)
}

// ---------- Proxy Tunnel HTTP handlers ----------

func (s *Store) openTunnel(w http.ResponseWriter, r *http.Request) {
	var req OpenBrowserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	s.tunnelMu.Lock()
	defer s.tunnelMu.Unlock()

	// Already running
	if t, ok := s.tunnels[req.EnvironmentID]; ok {
		writeJSON(w, http.StatusOK, map[string]any{"port": t.localPort, "running": true})
		return
	}

	s.mu.Lock()
	env, ok := s.findEnvironment(req.EnvironmentID)
	s.mu.Unlock()
	if !ok || !env.Proxy.Enabled || env.Proxy.Host == "" || env.Proxy.Port == "" {
		writeError(w, http.StatusBadRequest, "no proxy configured for this environment")
		return
	}

	// Only SOCKS5 needs a tunnel (HTTP proxy works natively in Electron)
	if env.Proxy.Type == "http" || env.Proxy.Type == "https" {
		writeJSON(w, http.StatusOK, map[string]any{"port": 0, "direct": true, "host": env.Proxy.Host, "proxyPort": env.Proxy.Port, "type": env.Proxy.Type})
		return
	}

	t, err := startProxyTunnel(env.Proxy)
	if err != nil {
		log.Printf("[tunnel] failed to start for env %s: %v", req.EnvironmentID, err)
		writeError(w, http.StatusInternalServerError, "failed to start tunnel")
		return
	}
	t.envID = req.EnvironmentID
	s.tunnels[req.EnvironmentID] = t
	log.Printf("[tunnel] started for env %s on port %d (-> %s:%s)", req.EnvironmentID, t.localPort, env.Proxy.Host, env.Proxy.Port)
	writeJSON(w, http.StatusOK, map[string]any{"port": t.localPort, "running": true})
}

func (s *Store) closeTunnel(w http.ResponseWriter, r *http.Request) {
	var req OpenBrowserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	s.stopTunnel(req.EnvironmentID)
	writeJSON(w, http.StatusOK, map[string]any{"stopped": true})
}

func (s *Store) stopTunnel(envID string) {
	s.tunnelMu.Lock()
	defer s.tunnelMu.Unlock()
	if t, ok := s.tunnels[envID]; ok {
		t.stop()
		delete(s.tunnels, envID)
		log.Printf("[tunnel] stopped for env %s", envID)
	}
}

func (s *Store) findEnvironment(id string) (Environment, bool) {
	for _, env := range s.environments {
		if env.ID == id {
			return env, true
		}
	}
	return Environment{}, false
}

func (s *Store) save() error {
	data, err := json.MarshalIndent(s.environments, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.path, data, 0o600)
}

func browserArgs(env Environment) []string {
	debugPort := env.DebugPort
	if debugPort <= 0 {
		debugPort, _ = strconv.Atoi(remoteDebuggingPort(env.ID))
	}
	args := []string{
		"--environment-id=" + env.ID,
		"--user-data-dir=" + filepath.Join(defaultDataDir(), "profiles", env.ID),
		"--home-url=" + env.HomeURL,
		"--remote-debugging-port=" + fmt.Sprintf("%d", debugPort),
	}
	if env.Proxy.Enabled && env.Proxy.Host != "" && env.Proxy.Port != "" {
		args = append(args, "--proxy-server="+env.Proxy.Type+"://"+env.Proxy.Host+":"+env.Proxy.Port)
	}
	return args
}

func remoteDebuggingPort(environmentID string) string {
	sum := 0
	for _, r := range environmentID {
		sum += int(r)
	}
	return fmt.Sprintf("%d", 9000+sum%1000)
}

func defaultDataDir() string {
	if configured := strings.TrimSpace(os.Getenv("IPAUPLOADER_DAEMON_DATA_DIR")); configured != "" {
		return configured
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "Application Support", "IPAUploaderNext")
}

func defaultDataPath() string {
	return filepath.Join(defaultDataDir(), "environments.json")
}

func browserCorePath() string {
	if path := os.Getenv("BROWSER_CORE_PATH"); path != "" {
		return path
	}
	executable, err := os.Executable()
	if err == nil {
		candidates := []string{
			filepath.Join(filepath.Dir(executable), "..", "browser-core", "build", "browser-core.app", "Contents", "MacOS", "browser-core"),
			filepath.Join(filepath.Dir(executable), "..", "browser-core", "build", "browser-core"),
		}
		for _, candidate := range candidates {
			if _, statErr := os.Stat(candidate); statErr == nil {
				return candidate
			}
		}
	}
	appPath := filepath.Join("..", "browser-core", "build", "browser-core.app", "Contents", "MacOS", "browser-core")
	if _, statErr := os.Stat(appPath); statErr == nil {
		return appPath
	}
	return filepath.Join("..", "browser-core", "build", "browser-core")
}

func randomID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return time.Now().Format("20060102150405")
	}
	return hex.EncodeToString(b[:])
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{"error": message})
}

// ---------- Proxy IP Detection ----------

type ProxyDetectRequest struct {
	Proxy               ProxyConfig `json:"proxy"`
	AllowDirectFallback bool        `json:"allowDirectFallback"`
}

func handleProxyDetect(w http.ResponseWriter, r *http.Request) {
	var req ProxyDetectRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	writeJSON(w, http.StatusOK, detectIP(req.Proxy, req.AllowDirectFallback))
}

func detectIP(proxy ProxyConfig, allowDirectFallback bool) map[string]any {
	emptyResult := func() map[string]any {
		return map[string]any{
			"ip": "—", "country": "—", "region": "—", "city": "—",
			"isp": "—", "lat": "—", "lon": "—", "timezone": "—",
			"proxyText": "未知", "source": "全部检测源",
			"statusText": "网络不可用", "checkedAt": time.Now().Format("2006-01-02 15:04:05"),
		}
	}
	useProxy := proxy.Enabled && proxy.Host != "" && proxy.Port != ""

	if useProxy {
		if r := tryAllDetectors(proxy, true); r != nil {
			return r
		}
		if allowDirectFallback {
			log.Printf("[proxy-detect] ALL detectors failed via proxy %s:%s, falling back to direct", proxy.Host, proxy.Port)
			if r := tryAllDetectors(ProxyConfig{}, false); r != nil {
				r["proxyText"] = "代理失败，显示本机IP"
				r["statusText"] = "代理不可达，已降级为直连"
				return r
			}
		} else {
			log.Printf("[proxy-detect] ALL detectors failed via proxy %s:%s, direct fallback disabled", proxy.Host, proxy.Port)
		}
	} else {
		if r := tryAllDetectors(ProxyConfig{}, false); r != nil {
			r["proxyText"] = "真实 IP"
			r["statusText"] = "本机IP检测成功"
			return r
		}
	}
	return emptyResult()
}

// tryAllDetectors fires all detectors in parallel. If successful detectors
// disagree on the IP, return a mismatch result so the browser can lock access.
func tryAllDetectors(proxy ProxyConfig, useProxy bool) map[string]any {
	type detector struct {
		name  string
		url   string
		parse func(string) map[string]any
	}

	detectors := []detector{
		{"ip-api.com", "http://ip-api.com/json/?fields=status,message,country,regionName,city,isp,lat,lon,timezone,proxy,query", parseIPAPI},
		{"httpbin.org", "http://httpbin.org/ip", parseSimpleIP},
		{"myip.ipip.net", "http://myip.ipip.net", parseIPIP},
		{"ifconfig.me", "http://ifconfig.me/ip", parseSimpleIP},
		{"icanhazip.com", "http://icanhazip.com", parseSimpleIP},
		{"checkip.amazonaws.com", "http://checkip.amazonaws.com", parseSimpleIP},
		{"api.ip.sb", "http://api.ip.sb/geoip", parseIPSB},
	}

	type result struct {
		data map[string]any
	}
	ch := make(chan result, len(detectors))
	total := len(detectors)

	for _, d := range detectors {
		go func(det detector) {
			if r := execDetector(det.name, det.url, det.parse, proxy, useProxy); r != nil {
				ch <- result{r}
			} else {
				ch <- result{} // signal failure
			}
		}(d)
	}

	// Proxy needs longer overall timeout due to CONNECT/SOCKS handshake
	overallTimeout := 3000 * time.Millisecond
	if useProxy {
		overallTimeout = 6000 * time.Millisecond
	}
	timeout := time.After(overallTimeout)
	failed := 0
	successes := []map[string]any{}
	for {
		select {
		case r := <-ch:
			if r.data != nil {
				successes = append(successes, r.data)
			} else {
				failed++
			}
			if failed+len(successes) >= total {
				return resolveDetectorResults(successes)
			}
		case <-timeout:
			return resolveDetectorResults(successes)
		}
	}
}

func canonicalIPValue(value any) string {
	raw := strings.TrimSpace(fmt.Sprintf("%v", value))
	if raw == "" || raw == "—" {
		return ""
	}
	// Some detectors can return "client, proxy" style values. The first valid
	// address is the outward client IP for our purposes.
	parts := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\n' || r == '\t'
	})
	for _, part := range parts {
		clean := strings.TrimSpace(part)
		if net.ParseIP(clean) != nil {
			return clean
		}
	}
	return ""
}

func resolveDetectorResults(results []map[string]any) map[string]any {
	if len(results) == 0 {
		return nil
	}
	first := preferredLocaleResult(results)
	firstIP := canonicalIPValue(first["ip"])
	if firstIP == "" {
		return nil
	}
	first["ip"] = firstIP
	seen := map[string]bool{firstIP: true}
	ips := []string{firstIP}
	sources := []string{fmt.Sprintf("%v", first["source"])}
	for _, result := range results[1:] {
		ip := canonicalIPValue(result["ip"])
		if ip == "" {
			continue
		}
		result["ip"] = ip
		source := fmt.Sprintf("%v", result["source"])
		if !seen[ip] {
			seen[ip] = true
			ips = append(ips, ip)
		}
		if source != "" && source != "<nil>" {
			sources = append(sources, source+":"+ip)
		}
	}
	if len(ips) > 1 {
		mismatch := map[string]any{}
		for k, v := range first {
			mismatch[k] = v
		}
		mismatch["ipMismatch"] = true
		mismatch["mismatchIPs"] = strings.Join(ips, " / ")
		mismatch["mismatchSources"] = strings.Join(sources, "；")
		mismatch["statusText"] = "多个检测源返回不同出口IP"
		mismatch["proxyText"] = "出口IP不一致"
		log.Printf("[proxy-detect] IP mismatch across detectors: %s (%s)", mismatch["mismatchIPs"], mismatch["mismatchSources"])
		return mismatch
	}
	return first
}

func usefulLocaleValue(value any) bool {
	text := strings.TrimSpace(fmt.Sprintf("%v", value))
	return text != "" && text != "—" && text != "<nil>"
}

func localeScore(result map[string]any) int {
	if result == nil {
		return 0
	}
	score := 0
	if usefulLocaleValue(result["country"]) {
		score += 4
	}
	if usefulLocaleValue(result["region"]) {
		score += 2
	}
	if usefulLocaleValue(result["city"]) {
		score++
	}
	source := strings.ToLower(fmt.Sprintf("%v", result["source"]))
	if source == "ip-api.com" || source == "api.ip.sb" {
		score += 2
	}
	if source == "myip.ipip.net" {
		score++
	}
	return score
}

func preferredLocaleResult(results []map[string]any) map[string]any {
	best := results[0]
	bestScore := localeScore(best)
	for _, result := range results[1:] {
		score := localeScore(result)
		if score > bestScore {
			best = result
			bestScore = score
		}
	}
	return best
}

func execDetector(name, url string, parse func(string) map[string]any, proxy ProxyConfig, useProxy bool) map[string]any {
	maxTime := "2"
	connectTimeout := "1"
	if useProxy {
		// Proxy needs extra time for CONNECT / SOCKS handshake
		maxTime = "5"
		connectTimeout = "3"
	}
	args := []string{"-s", "--max-time", maxTime, "--connect-timeout", connectTimeout, url}
	if useProxy {
		proto := proxy.Type
		if proto != "http" && proto != "socks5" {
			proto = "http"
		}
		auth := ""
		if proxy.Username != "" {
			auth = proxy.Username
			if proxy.Password != "" {
				auth += ":" + proxy.Password
			}
			auth += "@"
		}
		if proto == "socks5" {
			// SOCKS5 认证不能用 --proxy，必须用 --socks5-hostname
			args = []string{"-s", "--max-time", maxTime, "--connect-timeout", connectTimeout,
				"--socks5-hostname", auth + proxy.Host + ":" + proxy.Port, url}
		} else {
			// HTTP/HTTPS proxy
			args = []string{"-s", "--max-time", maxTime, "--connect-timeout", connectTimeout,
				"--proxy", proto + "://" + auth + proxy.Host + ":" + proxy.Port, url}
		}
	}
	cmd := exec.Command("curl", args...)
	output, err := cmd.Output()
	if err != nil {
		if useProxy {
			log.Printf("[proxy-detect] %s failed via proxy %s://%s:%s: %v", name, proxy.Type, proxy.Host, proxy.Port, err)
		}
		return nil
	}
	r := parse(string(output))
	if r != nil {
		r["source"] = name
		if useProxy {
			r["proxyText"] = "代理/VPN"
			r["statusText"] = "代理出口IP检测成功"
			log.Printf("[proxy-detect] success via %s, proxy %s:%s, IP=%v", name, proxy.Host, proxy.Port, r["ip"])
		}
	}
	return r
}

// ---- Parsers ----

func parseIPAPI(raw string) map[string]any {
	var data map[string]any
	if err := json.Unmarshal([]byte(raw), &data); err != nil {
		return nil
	}
	status, _ := data["status"].(string)
	if status != "success" {
		return nil
	}
	return map[string]any{
		"ip": data["query"], "country": data["country"], "region": data["regionName"],
		"city": data["city"], "isp": data["isp"],
		"lat": fmt.Sprintf("%v", data["lat"]), "lon": fmt.Sprintf("%v", data["lon"]),
		"timezone": data["timezone"], "checkedAt": time.Now().Format("2006-01-02 15:04:05"),
	}
}

func parseIPIP(raw string) map[string]any {
	// myip.ipip.net returns: "当前 IP：1.2.3.4  来自于：中国 北京 电信"
	text := strings.TrimSpace(raw)
	var ip string
	if idx := strings.Index(text, "："); idx >= 0 {
		rest := text[idx+len("："):]
		parts := strings.Fields(rest)
		if len(parts) > 0 {
			ip = parts[0]
		}
	} else {
		ip = strings.TrimSpace(text)
	}
	if ip == "" {
		return nil
	}
	var country, region, isp string
	if idx := strings.Index(text, "来自于"); idx >= 0 {
		rest := strings.TrimSpace(text[idx+len("来自于："):])
		parts := strings.Fields(rest)
		if len(parts) > 0 {
			country = parts[0]
		}
		if len(parts) > 1 {
			region = parts[1]
		}
		if len(parts) > 2 {
			isp = parts[2]
		}
	}
	return map[string]any{
		"ip": ip, "country": country, "region": region, "city": "—",
		"isp": isp, "lat": "—", "lon": "—", "timezone": "—",
		"checkedAt": time.Now().Format("2006-01-02 15:04:05"),
	}
}

func parseSimpleIP(raw string) map[string]any {
	text := strings.TrimSpace(raw)
	// Try JSON first
	if strings.HasPrefix(text, "{") {
		var data map[string]any
		if json.Unmarshal([]byte(text), &data) == nil {
			if ip, ok := data["origin"]; ok {
				return simpleResult(fmt.Sprintf("%v", ip))
			}
			if ip, ok := data["ip"]; ok {
				return simpleResult(fmt.Sprintf("%v", ip))
			}
		}
	}
	// Plain text IP
	if net.ParseIP(text) != nil {
		return simpleResult(text)
	}
	// Get first line that looks like an IP
	lines := strings.Split(text, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if net.ParseIP(line) != nil {
			return simpleResult(line)
		}
	}
	return nil
}

func parseIPSB(raw string) map[string]any {
	var data map[string]any
	if err := json.Unmarshal([]byte(raw), &data); err != nil {
		return nil
	}
	return map[string]any{
		"ip": data["ip"], "country": fmt.Sprintf("%v", data["country"]),
		"region": fmt.Sprintf("%v", data["region"]), "city": fmt.Sprintf("%v", data["city"]),
		"isp": fmt.Sprintf("%v", data["isp"]),
		"lat": fmt.Sprintf("%v", data["latitude"]), "lon": fmt.Sprintf("%v", data["longitude"]),
		"timezone": fmt.Sprintf("%v", data["timezone"]), "checkedAt": time.Now().Format("2006-01-02 15:04:05"),
	}
}

func simpleResult(ip string) map[string]any {
	return map[string]any{
		"ip": ip, "country": "—", "region": "—", "city": "—", "isp": "—",
		"lat": "—", "lon": "—", "timezone": "—",
		"checkedAt": time.Now().Format("2006-01-02 15:04:05"),
	}
}

// ---------- Update / Delete environments ----------

func (s *Store) updateEnvironment(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var updated Environment
	if err := json.NewDecoder(r.Body).Decode(&updated); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, env := range s.environments {
		if env.ID == id {
			updated.ID = id
			if env.SerialNum != "" {
				updated.SerialNum = env.SerialNum
			}
			updated.CreatedAt = env.CreatedAt
			if updated.Name == "" {
				updated.Name = env.Name
			}
			s.environments[i] = updated
			if err := s.save(); err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			writeJSON(w, http.StatusOK, updated)
			return
		}
	}
	writeError(w, http.StatusNotFound, "environment not found")
}

func (s *Store) deleteEnvironment(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	s.mu.Lock()
	defer s.mu.Unlock()
	if cmd, ok := s.processes[id]; ok && cmd != nil && cmd.Process != nil {
		cmd.Process.Kill()
		delete(s.processes, id)
	}
	for i, env := range s.environments {
		if env.ID == id {
			s.environments = append(s.environments[:i], s.environments[i+1:]...)
			s.save()
			writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
			return
		}
	}
	writeError(w, http.StatusNotFound, "environment not found")
}
