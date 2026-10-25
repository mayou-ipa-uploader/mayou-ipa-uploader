@echo off
setlocal
set "CALLER_DIR=%CD%"
set "WOA_TOP_LEVEL=%~dp0.."
if defined ITMS_TRANSPORTER_JAVA_HOME (
  set "JAVA_EXE=%ITMS_TRANSPORTER_JAVA_HOME%\bin\java.exe"
) else if defined JAVA_HOME (
  set "JAVA_EXE=%JAVA_HOME%\bin\java.exe"
) else (
  set "JAVA_EXE=%WOA_TOP_LEVEL%\java\bin\java.exe"
)
if not exist "%JAVA_EXE%" (
  echo iTMSTransporter: bundled Java runtime is missing. 1>&2
  exit /b 1
)
set "ITMS_TMP=%TEMP%\itms-tx-tmp-%RANDOM%-%RANDOM%"
mkdir "%ITMS_TMP%" >nul 2>nul
pushd "%WOA_TOP_LEVEL%"
"%JAVA_EXE%" -Xmx2048m -Xms1024m -Djava.awt.headless=true "-Djava.io.tmpdir=%ITMS_TMP%" -Dclean.tmpdir=true -Djava.net.preferIPv4Stack=true -Dhttps.protocols=TLSv1.3,TLSv1.2 -Dsun.net.http.retryPost=false "-Dcom.webobjects.pid=%RANDOM%" "-DWOUserDirectory=%CALLER_DIR%" "-DWOApplicationClass=com.apple.transporter.launcher.Application" "-DWOPlatform=Windows" "-Ditms-tx.install.dir=%WOA_TOP_LEVEL%" -p "%WOA_TOP_LEVEL%\modules" --add-modules=java.compiler,java.net.http,java.sql,java.xml,java.scripting --add-exports=java.base/sun.security.pkcs=com.apple.transporter.launcher --add-exports=java.base/sun.security.provider.certpath=ALL-UNNAMED --add-exports=java.base/sun.security.util=com.apple.transporter.launcher --add-exports=java.base/sun.security.x509=com.apple.transporter.launcher -m com.apple.transporter.launcher/com.apple.transporter.app.Application %*
set "RESULT=%ERRORLEVEL%"
popd
rmdir /s /q "%ITMS_TMP%" >nul 2>nul
exit /b %RESULT%
