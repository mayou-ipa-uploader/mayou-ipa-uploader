const { ipcRenderer } = require("electron");

function getFingerprint() {
  try {
    const params = new URLSearchParams(window.location.search || "");
    const envId = params.get("__ipauploader_env_id") || "";
    return ipcRenderer.sendSync("browser-get-fingerprint", { envId, userAgent: navigator.userAgent });
  } catch (e) {
    return null;
  }
}

function injectFingerprintHook() {
  const fp = getFingerprint();
  if (!fp || !fp.userAgent) return;
  const script = document.createElement("script");
  script.textContent = `
    (function(){
      if (window.__ipauploaderFingerprintHooked) return;
      window.__ipauploaderFingerprintHooked = true;
      var fp = ${JSON.stringify(fp)};
      var languages = String(fp.languages || fp.language || "zh-CN").split(",").map(function(v){ return v.trim(); }).filter(Boolean);

      function defineGetter(proto, key, value) {
        try {
          Object.defineProperty(proto, key, {
            get: function(){ return value; },
            configurable: true
          });
        } catch (e) {}
      }

      defineGetter(Navigator.prototype, "userAgent", fp.userAgent);
      defineGetter(Navigator.prototype, "appVersion", fp.userAgent.replace(/^Mozilla\\//, ""));
      defineGetter(Navigator.prototype, "platform", fp.platform);
      defineGetter(Navigator.prototype, "vendor", fp.vendor || "Google Inc.");
      defineGetter(Navigator.prototype, "language", fp.language || languages[0] || "zh-CN");
      defineGetter(Navigator.prototype, "languages", languages);
      defineGetter(Navigator.prototype, "hardwareConcurrency", Number(fp.hardwareConcurrency || 8));
      defineGetter(Navigator.prototype, "deviceMemory", Number(fp.deviceMemory || 8));
      defineGetter(Navigator.prototype, "deviceName", fp.deviceName || "");

      ["width","availWidth"].forEach(function(key){ defineGetter(Screen.prototype, key, Number(fp.screenWidth || 1440)); });
      ["height","availHeight"].forEach(function(key){ defineGetter(Screen.prototype, key, Number(fp.screenHeight || 900)); });
      defineGetter(Screen.prototype, "colorDepth", Number(fp.colorDepth || 24));
      defineGetter(Screen.prototype, "pixelDepth", Number(fp.colorDepth || 24));

      var nativeDateTimeFormat = Intl.DateTimeFormat;
      Intl.DateTimeFormat = function(locales, options) {
        var normalizedOptions = options ? Object.assign({}, options) : {};
        if (fp.timezone && !normalizedOptions.timeZone) normalizedOptions.timeZone = fp.timezone;
        return new nativeDateTimeFormat(locales, normalizedOptions);
      };
      Intl.DateTimeFormat.prototype = nativeDateTimeFormat.prototype;
      Object.setPrototypeOf(Intl.DateTimeFormat, nativeDateTimeFormat);
      Intl.DateTimeFormat.supportedLocalesOf = nativeDateTimeFormat.supportedLocalesOf.bind(nativeDateTimeFormat);

      ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"].forEach(function(method) {
        var nativeMethod = Date.prototype[method];
        Date.prototype[method] = function(locales, options) {
          var normalizedOptions = options ? Object.assign({}, options) : {};
          if (fp.timezone && !normalizedOptions.timeZone) normalizedOptions.timeZone = fp.timezone;
          return nativeMethod.call(this, locales, normalizedOptions);
        };
      });
      var nativeGetTimezoneOffset = Date.prototype.getTimezoneOffset;
      Date.prototype.getTimezoneOffset = function() {
        if (!fp.timezone) return nativeGetTimezoneOffset.call(this);
        try {
          var parts = new nativeDateTimeFormat("en-US", {
            timeZone: fp.timezone,
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit",
            hourCycle: "h23"
          }).formatToParts(this);
          var values = {};
          parts.forEach(function(part) { if (part.type !== "literal") values[part.type] = Number(part.value); });
          var localAsUTC = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second);
          return Math.round((this.getTime() - localAsUTC) / 60000);
        } catch (e) {
          return nativeGetTimezoneOffset.call(this);
        }
      };

      function noiseValue() {
        var seed = parseInt(String(fp.canvasNoise || "0").slice(0, 8), 16) || 0;
        return (seed % 7) - 3;
      }
      var canvasNoise = noiseValue();
      var nativeToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function() {
        try {
          var ctx = this.getContext("2d");
          if (ctx && this.width && this.height) {
            var image = ctx.getImageData(0, 0, Math.min(1, this.width), Math.min(1, this.height));
            image.data[0] = (image.data[0] + canvasNoise + 256) % 256;
            ctx.putImageData(image, 0, 0);
          }
        } catch (e) {}
        return nativeToDataURL.apply(this, arguments);
      };
      var nativeGetImageData = CanvasRenderingContext2D.prototype.getImageData;
      CanvasRenderingContext2D.prototype.getImageData = function() {
        var image = nativeGetImageData.apply(this, arguments);
        try {
          if (image && image.data && image.data.length > 0) {
            image.data[0] = (image.data[0] + canvasNoise + 256) % 256;
          }
        } catch (e) {}
        return image;
      };

      function patchWebGL(proto) {
        if (!proto || !proto.getParameter) return;
        var nativeGetParameter = proto.getParameter;
        proto.getParameter = function(parameter) {
          if (parameter === 37445) return fp.webGLVendor || "Google Inc.";
          if (parameter === 37446) return fp.webGLRenderer || "ANGLE";
          return nativeGetParameter.apply(this, arguments);
        };
      }
      patchWebGL(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
      patchWebGL(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);

      if (fp.webrtcMode === "replace" && fp.webrtcPublicIP && window.RTCIceCandidate) {
        var replaceCandidateAddress = function(candidate) {
          var value = String(candidate || "");
          return value.replace(/^(candidate:\S+\s+\d+\s+\S+\s+\d+\s+)(\S+)/, function(_all, prefix) {
            return prefix + fp.webrtcPublicIP;
          });
        };
        var candidateDescriptor = Object.getOwnPropertyDescriptor(RTCIceCandidate.prototype, "candidate");
        if (candidateDescriptor && candidateDescriptor.get) {
          try {
            Object.defineProperty(RTCIceCandidate.prototype, "candidate", {
              configurable: true,
              enumerable: candidateDescriptor.enumerable,
              get: function() { return replaceCandidateAddress(candidateDescriptor.get.call(this)); }
            });
          } catch (e) {}
        }
        var addressDescriptor = Object.getOwnPropertyDescriptor(RTCIceCandidate.prototype, "address");
        if (addressDescriptor && addressDescriptor.get) {
          try {
            Object.defineProperty(RTCIceCandidate.prototype, "address", {
              configurable: true,
              enumerable: addressDescriptor.enumerable,
              get: function() { return fp.webrtcPublicIP; }
            });
          } catch (e) {}
        }
        var nativeCandidateToJSON = RTCIceCandidate.prototype.toJSON;
        if (nativeCandidateToJSON) {
          RTCIceCandidate.prototype.toJSON = function() {
            var result = nativeCandidateToJSON.call(this);
            result.candidate = replaceCandidateAddress(result.candidate);
            if ("address" in result) result.address = fp.webrtcPublicIP;
            return result;
          };
        }
      }

      if (fp.webrtcMode === "block") {
        var rtcError = function() { throw new DOMException("WebRTC 已被浏览器环境禁用", "SecurityError"); };
        try { window.RTCPeerConnection = rtcError; } catch (e) {}
        try { window.webkitRTCPeerConnection = rtcError; } catch (e) {}
        try { window.RTCDataChannel = rtcError; } catch (e) {}
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
          navigator.mediaDevices.getUserMedia = function() {
            return Promise.reject(new DOMException("WebRTC 已被浏览器环境禁用", "SecurityError"));
          };
        }
      }

      function createGeoError(code, message) {
        return { code: code, message: message, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 };
      }
      function createGeoPosition() {
        var latitude = Number(fp.geoLatitude);
        var longitude = Number(fp.geoLongitude);
        if (!isFinite(latitude) || !isFinite(longitude)) {
          latitude = 30.274084;
          longitude = 120.155070;
        }
        return {
          coords: {
            latitude: latitude,
            longitude: longitude,
            accuracy: Number(fp.geoAccuracy || 50),
            altitude: null,
            altitudeAccuracy: null,
            heading: null,
            speed: null
          },
          timestamp: Date.now()
        };
      }
      if (navigator.geolocation) {
        var geoWatchTimers = {};
        var geoWatchId = 1;
        if (navigator.permissions && navigator.permissions.query) {
          var nativePermissionQuery = navigator.permissions.query.bind(navigator.permissions);
          navigator.permissions.query = function(desc) {
            if (desc && desc.name === "geolocation") {
              var state = fp.geoPermission === "block" ? "denied" : fp.geoPermission === "ask" ? "prompt" : "granted";
              return Promise.resolve({ state: state, onchange: null });
            }
            return nativePermissionQuery(desc);
          };
        }
        navigator.geolocation.getCurrentPosition = function(success, error) {
          if (fp.geoPermission === "block") {
            if (typeof error === "function") {
              setTimeout(function(){ error(createGeoError(1, "User denied Geolocation")); }, 0);
            }
            return;
          }
          if (typeof success === "function") {
            setTimeout(function(){ success(createGeoPosition()); }, 0);
          }
        };
        navigator.geolocation.watchPosition = function(success, error) {
          if (fp.geoPermission === "block") {
            if (typeof error === "function") {
              setTimeout(function(){ error(createGeoError(1, "User denied Geolocation")); }, 0);
            }
            return 0;
          }
          var id = geoWatchId++;
          if (typeof success === "function") {
            geoWatchTimers[id] = setInterval(function(){ success(createGeoPosition()); }, 1000);
            setTimeout(function(){ success(createGeoPosition()); }, 0);
          }
          return id;
        };
        navigator.geolocation.clearWatch = function(id) {
          if (geoWatchTimers[id]) clearInterval(geoWatchTimers[id]);
          delete geoWatchTimers[id];
        };
      }

      function isLocalURL(rawUrl) {
        try {
          var url = new URL(String(rawUrl), window.location.href);
          var host = url.hostname.toLowerCase();
          if (host === "localhost" || host === "0.0.0.0" || host === "::1" || host === "[::1]") return true;
          if (/^127\\./.test(host)) return true;
          if (/^10\\./.test(host)) return true;
          if (/^192\\.168\\./.test(host)) return true;
          var m = host.match(/^172\\.(\\d+)\\./);
          if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
          if (host.endsWith(".local")) return true;
        } catch (e) {}
        return false;
      }
      function blockLocalURL(rawUrl) {
        if (fp.portScanProtection === false) return false;
        return isLocalURL(rawUrl);
      }
      function portScanError() {
        return new DOMException("本地端口扫描已被浏览器环境保护拦截", "SecurityError");
      }
      var nativeFetch = window.fetch;
      if (nativeFetch) {
        window.fetch = function(input, init) {
          var rawUrl = input && input.url ? input.url : input;
          if (blockLocalURL(rawUrl)) return Promise.reject(portScanError());
          return nativeFetch.apply(this, arguments);
        };
      }
      var nativeOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url) {
        if (blockLocalURL(url)) throw portScanError();
        return nativeOpen.apply(this, arguments);
      };
      var NativeWebSocket = window.WebSocket;
      if (NativeWebSocket) {
        var ProtectedWebSocket = function(url, protocols) {
          if (blockLocalURL(url)) throw portScanError();
          return protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
        };
        ProtectedWebSocket.prototype = NativeWebSocket.prototype;
        Object.setPrototypeOf(ProtectedWebSocket, NativeWebSocket);
        window.WebSocket = ProtectedWebSocket;
      }
      var NativeEventSource = window.EventSource;
      if (NativeEventSource) {
        var ProtectedEventSource = function(url, config) {
          if (blockLocalURL(url)) throw portScanError();
          return new NativeEventSource(url, config);
        };
        ProtectedEventSource.prototype = NativeEventSource.prototype;
        Object.setPrototypeOf(ProtectedEventSource, NativeEventSource);
        window.EventSource = ProtectedEventSource;
      }
      if (navigator.sendBeacon) {
        var nativeSendBeacon = navigator.sendBeacon.bind(navigator);
        navigator.sendBeacon = function(url, data) {
          if (blockLocalURL(url)) return false;
          return nativeSendBeacon(url, data);
        };
      }
      function protectURLSetter(proto, prop) {
        if (!proto) return;
        var desc = Object.getOwnPropertyDescriptor(proto, prop);
        if (!desc || !desc.set) return;
        Object.defineProperty(proto, prop, {
          get: desc.get,
          set: function(value) {
            if (blockLocalURL(value)) throw portScanError();
            return desc.set.call(this, value);
          },
          configurable: true
        });
      }
      protectURLSetter(window.HTMLImageElement && HTMLImageElement.prototype, "src");
      protectURLSetter(window.HTMLScriptElement && HTMLScriptElement.prototype, "src");
      protectURLSetter(window.HTMLIFrameElement && HTMLIFrameElement.prototype, "src");
      protectURLSetter(window.HTMLLinkElement && HTMLLinkElement.prototype, "href");
      var nativeSetAttribute = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function(name, value) {
        var attr = String(name || "").toLowerCase();
        if ((attr === "src" || attr === "href" || attr === "action") && blockLocalURL(value)) {
          throw portScanError();
        }
        return nativeSetAttribute.apply(this, arguments);
      };

      function rewriteCandidate(candidate) {
        if (!candidate || !fp.hostIp) return candidate;
        return String(candidate).replace(/\\b(?:127\\.\\d+\\.\\d+\\.\\d+|10\\.\\d+\\.\\d+\\.\\d+|192\\.168\\.\\d+\\.\\d+|172\\.(?:1[6-9]|2\\d|3[0-1])\\.\\d+\\.\\d+)\\b/g, fp.hostIp);
      }
      var NativeRTCPeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection;
      if (NativeRTCPeerConnection) {
        function rewriteCandidateEvent(event) {
          if (!event || !event.candidate || !event.candidate.candidate) return event;
          var rewritten = rewriteCandidate(event.candidate.candidate);
          if (rewritten === event.candidate.candidate) return event;
          var candidate = Object.create(event.candidate);
          try { Object.defineProperty(candidate, "candidate", { value: rewritten, configurable: true }); } catch (e) {}
          var cloned = Object.create(event);
          try { Object.defineProperty(cloned, "candidate", { value: candidate, configurable: true }); } catch (e) {}
          return cloned;
        }
        var WrappedRTCPeerConnection = function(config) {
          var pc = new NativeRTCPeerConnection(config);
          var nativeAddEventListener = pc.addEventListener.bind(pc);
          pc.addEventListener = function(type, listener, options) {
            if (type !== "icecandidate" || typeof listener !== "function") {
              return nativeAddEventListener(type, listener, options);
            }
            return nativeAddEventListener(type, function(event) {
              return listener.call(this, rewriteCandidateEvent(event));
            }, options);
          };
          Object.defineProperty(pc, "onicecandidate", {
            set: function(listener) {
              if (typeof listener !== "function") return;
              nativeAddEventListener("icecandidate", function(event) {
                listener.call(pc, rewriteCandidateEvent(event));
              });
            },
            configurable: true
          });
          return pc;
        };
        WrappedRTCPeerConnection.prototype = NativeRTCPeerConnection.prototype;
        window.RTCPeerConnection = WrappedRTCPeerConnection;
        window.webkitRTCPeerConnection = WrappedRTCPeerConnection;
      }
    })();
  `;
  (document.documentElement || document.head).appendChild(script);
  script.remove();
}

function normalizeURL(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value || value === "about:blank") return "";
  try {
    return new URL(value, document.baseURI || window.location.href).href;
  } catch (e) {
    return value;
  }
}

function requestOpenTab(rawUrl) {
  const url = normalizeURL(rawUrl);
  if (!url || url === "about:blank") return false;
  ipcRenderer.sendToHost("open-tab", url);
  return true;
}

window.addEventListener("__ipauploader-open-tab", (event) => {
  requestOpenTab(event.detail && event.detail.url);
});

document.addEventListener("click", (event) => {
  ipcRenderer.sendToHost("webview-click");
  const target = event.target;
  const anchor = target && target.closest ? target.closest("a") : null;
  if (!anchor) return;

  const targetName = String(anchor.target || "").toLowerCase();
  const shouldOpenTab = targetName && targetName !== "_self";
  if (!shouldOpenTab) return;

  const href = anchor.href || anchor.getAttribute("href");
  if (requestOpenTab(href)) event.preventDefault();
}, true);

function injectOpenTabHook() {
  const script = document.createElement("script");
  script.textContent = `
    (function(){
      if (window.__ipauploaderOpenTabHooked) return;
      window.__ipauploaderOpenTabHooked = true;

      function emitOpenTab(rawUrl) {
        if (!rawUrl || rawUrl === "about:blank") return false;
        window.dispatchEvent(new CustomEvent("__ipauploader-open-tab", {
          detail: { url: rawUrl }
        }));
        return true;
      }

      function createPopupProxy() {
        var fakeWindow = {
          closed: false,
          close: function(){ this.closed = true; },
          focus: function(){ return true; },
          blur: function(){ return true; }
        };
        var locationProxy = {
          assign: function(url) { emitOpenTab(url); },
          replace: function(url) { emitOpenTab(url); }
        };
        Object.defineProperty(locationProxy, "href", {
          get: function(){ return "about:blank"; },
          set: function(url){ emitOpenTab(url); }
        });
        Object.defineProperty(fakeWindow, "location", {
          get: function(){ return locationProxy; },
          set: function(url){ emitOpenTab(url); }
        });
        return fakeWindow;
      }

      var nativeOpen = window.open;
      window.open = function(url, target, features) {
        var popup = createPopupProxy();
        if (emitOpenTab(url)) return popup;
        return nativeOpen.apply(this, arguments);
      };
    })();
  `;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

if (document.documentElement) {
  injectFingerprintHook();
  injectOpenTabHook();
} else {
  document.addEventListener("DOMContentLoaded", () => {
    injectFingerprintHook();
    injectOpenTabHook();
  }, { once: true });
}
