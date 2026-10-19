@echo off
rem Локальный запуск приложения: http://localhost:8080
start "" http://localhost:8080
"%~dp0..\.venv\Scripts\python.exe" -I -m http.server 8080 --bind 127.0.0.1 --directory "%~dp0"
