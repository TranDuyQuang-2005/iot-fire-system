# Android app – Capacitor và Firebase Cloud Messaging

Trạng thái hiện tại: **BACKEND FCM READY - DEVICE TEST PENDING**. APK debug, Firebase Android client config và Firebase Admin SDK trong backend Docker đã khởi tạo thành công. Chưa thể xác nhận FCM end-to-end cho đến khi notification được nhận và mở trên điện thoại Android thật.

## 1. Thông tin ứng dụng

- Tên hiển thị: `Giám sát an toàn`
- Capacitor app name: `IoT Fire Monitoring`
- Android application/package ID: `com.iotfire.monitoring`
- Web assets: `frontend/dist/iot-fire-ui/browser`
- Android project: `frontend/android`
- minSdk 24, targetSdk/compileSdk 36 (giá trị do Capacitor 8 tạo)

Web Dashboard tiếp tục dùng URL tương đối `/api` và `/iotHub`. Android dùng cùng Angular source nhưng gọi backend qua public HTTPS; app không chứa thông tin MQTT.

## 2. Cấu hình public HTTPS

Sửa đúng một giá trị `mobileServerUrl` trong `frontend/src/environments/environment.ts`:

```ts
const mobileServerUrl = 'https://laptop-jq3b9t7h.tailb58134.ts.net';
```

Không dùng `localhost`, `127.0.0.1` hoặc IPv4 LAN cho APK. URL phải truy cập được bằng 4G/5G và phục vụ cả:

```text
https://laptop-jq3b9t7h.tailb58134.ts.net/api
https://laptop-jq3b9t7h.tailb58134.ts.net/iotHub
```

## 3. Tạo Firebase Android app

Trong Firebase Console:

1. Tạo/chọn Firebase project.
2. Add app → Android.
3. Nhập package name chính xác: `com.iotfire.monitoring`.
4. Download `google-services.json`.
5. Đặt file thật tại `frontend/android/app/google-services.json`.

Máy build hiện đã có file đúng package tại `frontend/android/app/google-services.json`. File này được `.gitignore`; không tạo file mẫu giả và không commit file thật. Khi checkout source trên máy khác, phải tải lại file từ Firebase Console rồi chạy `npm.cmd run android:sync`.

## 4. Credential Firebase cho backend

Môi trường Docker trên máy hiện tại mount credential read-only tại `/run/secrets/firebase-service-account.json`; file nguồn nằm ngoài repository. Các bước dưới đây vẫn áp dụng khi triển khai sang máy khác.

Firebase Console → Project settings → Service accounts → Generate new private key. Lưu JSON ở nơi bảo mật ngoài repository. Backend đọc credential qua một trong các biến sau:

```text
Firebase__Enabled=true
FIREBASE_CREDENTIALS_PATH=<absolute-path-to-service-account-json>
Firebase__ProjectId=<firebase-project-id>       # tùy chọn
```

Hoặc dùng `GOOGLE_APPLICATION_CREDENTIALS`. Không đưa private key vào Angular, APK, Git, `.env.example` hay tài liệu.

Nếu chạy Docker, mount secret read-only và truyền đường dẫn trong container, ví dụ phần override riêng của môi trường triển khai:

```yaml
services:
  backend:
    volumes:
      - /secure/firebase-admin.json:/run/secrets/firebase-admin.json:ro
    environment:
      Firebase__Enabled: "true"
      Firebase__CredentialsPath: "/run/secrets/firebase-admin.json"
```

Nếu Firebase thiếu hoặc lỗi, backend chỉ ghi log; MQTT, SQL, SignalR và command vẫn tiếp tục hoạt động.

## 5. Notification và quyền Android

Sau login thành công, app giải thích qua giao diện và xin quyền `POST_NOTIFICATIONS` trên Android 13+. Nếu người dùng từ chối, Dashboard vẫn dùng được và hiển thị banner hướng dẫn bật lại trong Android Settings.

Các channel:

- `fire_critical`: FIRE, HIGH_RISK, SUPPRESSING; importance HIGH, sound và vibration.
- `warning`: WARNING, POST_FIRE.
- `system`: DEVICE_OFFLINE, DEVICE_ONLINE.

Khi foreground, SignalR cập nhật Dashboard và FCM được đưa vào toast/trung tâm thông báo; native foreground presentation bị tắt để tránh hiển thị trùng. `eventId` được dùng để deduplicate SignalR/FCM. Khi background hoặc app đóng, payload notification của FCM được Android hiển thị độc lập với SignalR. Bấm notification mở Dashboard kèm `event` và `eventId` trong route.

FCM token được đăng ký sau login tại `POST /api/push/register`, refresh bằng upsert token duy nhất và deactivate qua `POST /api/push/unregister` khi logout. JWT lấy từ native secure storage trên Android; phía web giữ behavior hiện có.

## 6. Build và cài debug APK

Yêu cầu: Node/npm, Android SDK và JDK tương thích với Android Gradle Plugin. Từ `frontend`:

```bat
npm.cmd install
npm.cmd run android:sync
cd android
gradlew.bat assembleDebug
```

APK debug đã build thành công:

```text
frontend/android/app/build/outputs/apk/debug/app-debug.apk
```

Kích thước bản build hiện tại: 5.67 MiB (5,944,926 byte).

Cài bằng Android Studio hoặc `adb install -r app-debug.apk`. Release build cần keystore thật do chủ dự án quản lý; không commit keystore hoặc password.

## 7. Checklist test thật

1. Mở app, login, chấp nhận notification; kiểm tra backend đã có một token active.
2. Foreground: telemetry/chart/command/alerts chạy realtime, mỗi event chỉ có một toast.
3. Background: tạo WARNING rồi FIRE; kiểm tra đúng title/body tiếng Việt và không lộ device ID/MQTT.
4. Đóng app: tạo FIRE; Android vẫn hiện native notification.
5. Bấm notification; app mở thẳng Dashboard và hiển thị trạng thái hiện tại.
6. Đổi Wi-Fi → 4G → Wi-Fi; SignalR tự reconnect, không tạo nhiều connection.
7. Logout; token bị deactivate, JWT bị xóa, SignalR đóng.

## 8. Lỗi thường gặp

- Không có FCM token: kiểm tra `google-services.json` đúng package và đã chạy `cap sync`.
- Không thấy notification Android 13+: bật quyền notification trong Settings.
- Foreground có hai thông báo: giữ `presentationOptions: []` trong `capacitor.config.ts`.
- App không gọi được API trên 4G: kiểm tra HTTPS certificate và Funnel/proxy cho `/api`, `/iotHub`.
- Backend log Firebase disabled: bật `Firebase__Enabled` và kiểm tra đường dẫn service account mà process/container đọc được.
- Gradle báo không có Java: cài JDK phù hợp, cấu hình `JAVA_HOME`, rồi chạy lại `gradlew.bat assembleDebug`.

## 9. Release APK

Bản phát hành Android chính thức được build từ `frontend/android` bằng `assembleRelease`. Sau khi xác minh chữ ký và metadata, chỉ copy nguyên binary đã ký sang `release/Giam-sat-an-toan-v<version>.apk`; không chỉnh sửa APK sau khi ký và không phát hành `app-debug.apk`.

Trước khi build, chạy Angular build và Capacitor sync. Ứng dụng release vẫn kết nối tới `https://laptop-jq3b9t7h.tailb58134.ts.net`. Backend/Tailscale Funnel trên máy chủ hiện tại phải online; nếu máy chủ dừng thì ứng dụng không truy cập được dữ liệu trực tuyến.

## 10. Versioning

`versionName` và `versionCode` nằm trong `frontend/android/app/build.gradle`. Mỗi lần phát hành phải tăng `versionCode`, không được tái sử dụng mã đã phát hành. Ví dụ: `1.0.0` dùng code `1`, `1.0.1` dùng code `2`, `1.1.0` dùng code `3`.

## 11. Release signing

Keystore cố định nằm ngoài repository tại `E:\iot-fire-secrets\android\iot-fire-release.keystore`. Credential nằm trong `E:\iot-fire-secrets\android\release-signing.properties` và Gradle chỉ đọc file này qua biến môi trường `IOT_FIRE_SIGNING_PROPERTIES`. Không ghi password vào source, tài liệu, APK hoặc Git.

**Không được làm mất, tạo lại hoặc ghi đè `iot-fire-release.keystore`.** Mọi bản cập nhật phải dùng đúng keystore/certificate này; nếu mất key, APK mới có thể không cập nhật được lên ứng dụng đã cài. Hãy backup keystore và signing properties ở nơi mã hóa, kiểm soát truy cập. Không upload hai file này lên GitHub hay GitHub Releases.

## 12. GitHub Releases

Mỗi release dùng annotated tag `v<version>`, tiêu đề thân thiện với người dùng, và chỉ đính kèm APK release đã ký cùng file SHA-256. Trước khi commit/push phải kiểm tra staged files để loại trừ keystore, signing properties, service-account JSON, `.env` và mọi private credential.

## 13. Updating the app

Để tạo bản cập nhật: tăng `versionName` và `versionCode`, giữ nguyên package `com.iotfire.monitoring`, Firebase project và release keystore; sau đó build, chạy `apksigner verify`, kiểm tra metadata, tạo checksum và publish bằng tag mới. Không tạo keystore mới cho từng version.
