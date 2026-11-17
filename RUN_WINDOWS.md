# CHAY HE THONG TREN WINDOWS

## Chuan bi

1. Copy `.env.example` thanh `.env` va thay tat ca gia tri `CHANGE_ME`.
2. Dam bao `mosquitto/config/password_file` co tai khoan trung voi `.env` va `secrets.h`.
3. Khong commit `.env`, `secrets.h`, `mqtt_ca.h` hoac password file.

## Chay toan bo local

```bat
cd /d E:\iot-fire-system
docker compose up -d --build
docker compose ps
```

- Frontend va API cung origin: `http://localhost:4200`
- Backend/Swagger chi nghe localhost: `http://localhost:8082/swagger`
- SQL Server chi nghe localhost: `localhost,1434`
- Mosquitto local: port `1883` (khong port-forward tren router; gioi han bang Windows Firewall neu can)

Frontend goi `/api` va `/iotHub`; Nginx trong container tu proxy den backend. Khi chay `npm start`, Angular dev proxy cung chuyen hai duong dan nay den backend port 8082.

## ESP32

Mo `arduino\IotFireSystem_ArduinoIDE\IotFireSystem_ArduinoIDE.ino`. Dung hostname broker trong `secrets.h`, khong ghi IP LAN co dinh. Cloud TLS can `MQTT_USE_TLS=true`, port `8883`, va CA PEM trong `mqtt_ca.h`.

Mapping relay da test: bom GPIO21, quat GPIO25. Logic FIRE cuc bo tiep tuc chay khi Wi-Fi/MQTT mat ket noi.

Xem [DEPLOY_REMOTE.md](DEPLOY_REMOTE.md) de chuyen MQTT cloud va mo dashboard bang Tailscale Funnel.
