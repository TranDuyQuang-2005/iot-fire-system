# TRUY CAP TU XA: MQTT CLOUD TLS + TAILSCALE FUNNEL

Kien truc nay khong can VPS: ESP32 va backend ket noi outbound den cung MQTT cloud bang hostname/TLS; laptop chay Docker; Tailscale Funnel chi cong khai frontend port 4200. SQL Server, Swagger va backend port 8082 khong duoc Funnel truc tiep.

## 1. Cau hinh MQTT cloud

Tao deployment tren nha cung cap MQTT cloud (vi du EMQX Serverless), sau do:

1. Tao hai tai khoan rieng cho ESP32 va backend, mat khau khac nhau.
2. Gioi han ACL theo cac topic `iot/fire/device/+/...` neu dich vu ho tro.
3. Lay broker hostname, MQTT TLS port `8883`, va tai CA certificate cua deployment.
4. Trong `.env`, dat:

```dotenv
MQTT_HOST=e1110a86.ala.asia-southeast1.emqxsl.com
MQTT_PORT=8883
MQTT_USE_TLS=true
MQTT_BACKEND_USERNAME=your_backend_user
MQTT_BACKEND_PASSWORD=your_backend_password
```

5. Trong ca `firmware/include/secrets.h` va `arduino/IotFireSystem_ArduinoIDE/secrets.h`, dat hostname, port 8883, `MQTT_USE_TLS true`, va tai khoan thiet bi.
6. Copy `mqtt_ca.example.h` thanh `mqtt_ca.h`, dan nguyen CA PEM cua deployment vao `MQTT_ROOT_CA`, roi flash ESP32.
7. Khoi dong lai backend:

```powershell
docker compose up -d --build backend frontend
docker compose logs --tail 100 backend
```

Backend dung trust store cua container va tu choi certificate sai hostname/khong hop le. ESP32 dung CA PEM va dong bo NTP truoc khi bat tay TLS; qua trinh cho NTP/MQTT khong block state machine an toan.

De quay lai Mosquitto local, dat hostname DNS/mDNS cua may chay Docker, port 1883, va `MQTT_USE_TLS=false` trong `.env` va hai file `secrets.h`. Khong can sua source. Khong port-forward port 1883 tren router.

## 2. Chay stack

```powershell
docker compose up -d --build
docker compose ps
```

Kiem tra tai `http://localhost:4200`. Dang nhap bat buoc; API va SignalR hub deu yeu cau JWT.

## 3. Mo Tailscale Funnel tren Windows

1. Cai Tailscale, dang nhap va dam bao may da online trong tailnet.
2. Mo PowerShell bang quyen Administrator.
3. Chay:

```powershell
tailscale funnel --bg 4200
tailscale funnel status
```

Lan dau, Tailscale co the mo trang duyet de phe duyet Funnel va HTTPS. Lenh se tra ve URL cong khai dang `https://<device>.<tailnet>.ts.net`. Mo URL nay tren 4G/5G de kiem tra login, dashboard, API va SignalR realtime.

Tat Funnel khi khong demo:

```powershell
tailscale funnel --bg 4200 off
```

Funnel la public Internet, khong chi rieng tailnet. Hay doi admin password, JWT key va MQTT passwords; khong chia se `.env`; khong Funnel port 8082, 1434 hoac 1883. Neu chi muon nguoi trong tailnet truy cap, dung Tailscale Serve thay vi Funnel.

## 4. Gioi han can thao tac ben ngoai

Repository khong the tu tao tai khoan/deployment MQTT cloud, tai CA rieng cua deployment, dang nhap Tailscale, phe duyet Funnel, hoac flash/test ESP32 vat ly. Cac gia tri do phai duoc dien vao cac file da git-ignore tren may van hanh.

Tai lieu tham chieu:

- Tailscale Funnel: https://tailscale.com/docs/features/tailscale-funnel
- Tailscale Funnel CLI: https://tailscale.com/docs/reference/tailscale-cli/funnel
- EMQX Cloud ports: https://docs.emqx.com/en/cloud/latest/deployments/port_guide_serverless.html
- EMQX ESP32 TLS: https://docs.emqx.com/en/cloud/latest/connect_to_deployments/esp32.html
