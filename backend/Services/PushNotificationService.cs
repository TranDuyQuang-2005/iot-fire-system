using System.Collections.Concurrent;
using FirebaseAdmin;
using FirebaseAdmin.Messaging;
using Google.Apis.Auth.OAuth2;
using IotFire.Api.Data;
using Microsoft.EntityFrameworkCore;

namespace IotFire.Api.Services;

public interface IPushNotificationService
{
    Task SendEventAsync(string eventType, string eventId, CancellationToken ct = default);
}

public sealed class PushNotificationService : IPushNotificationService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<PushNotificationService> _logger;
    private readonly FirebaseMessaging? _messaging;
    private readonly ConcurrentDictionary<string, DateTime> _recentEvents = new(StringComparer.Ordinal);

    private static readonly IReadOnlyDictionary<string, PushContent> Content =
        new Dictionary<string, PushContent>(StringComparer.Ordinal)
        {
            ["WARNING"] = new("⚠️ Có dấu hiệu bất thường", "Hệ thống phát hiện khói hoặc khí bất thường.", "warning"),
            ["HIGH_RISK"] = new("⚠️ Nguy cơ cháy cao", "Mức khói và nhiệt độ đang tăng nhanh. Vui lòng kiểm tra hệ thống.", "fire_critical"),
            ["FIRE"] = new("🔥 CẢNH BÁO CHÁY", "Hệ thống đã phát hiện cháy. Bơm chữa cháy đang được kích hoạt.", "fire_critical"),
            ["SUPPRESSING"] = new("🚨 Đang xử lý sự cố", "Hệ thống đang thực hiện xử lý cháy.", "fire_critical"),
            ["POST_FIRE"] = new("✅ Ngọn lửa đã được dập", "Hệ thống đang chờ kiểm tra và xác nhận an toàn.", "warning"),
            ["DEVICE_OFFLINE"] = new("📡 Mất kết nối", "Thiết bị giám sát đã mất kết nối.", "system"),
            ["DEVICE_ONLINE"] = new("✅ Đã kết nối lại", "Thiết bị giám sát đã hoạt động trở lại.", "system")
        };

    public PushNotificationService(
        IServiceScopeFactory scopeFactory,
        IConfiguration configuration,
        IWebHostEnvironment environment,
        ILogger<PushNotificationService> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;

        try
        {
            var configuredPath = configuration["Firebase:CredentialsPath"] ??
                                 Environment.GetEnvironmentVariable("FIREBASE_CREDENTIALS_PATH") ??
                                 Environment.GetEnvironmentVariable("GOOGLE_APPLICATION_CREDENTIALS");
            var enabled = bool.TryParse(configuration["Firebase:Enabled"], out var configuredEnabled)
                ? configuredEnabled
                : !string.IsNullOrWhiteSpace(configuredPath);

            if (!enabled || string.IsNullOrWhiteSpace(configuredPath))
            {
                _logger.LogWarning("Firebase push is disabled because no credential path is configured");
                return;
            }

            var credentialPath = Path.IsPathRooted(configuredPath)
                ? configuredPath
                : Path.Combine(environment.ContentRootPath, configuredPath);
            if (!File.Exists(credentialPath))
            {
                _logger.LogWarning("Firebase push is disabled because the credential file does not exist at {Path}", credentialPath);
                return;
            }

            var credential = CredentialFactory
                .FromFile<ServiceAccountCredential>(credentialPath)
                .ToGoogleCredential();
            var options = new AppOptions { Credential = credential };
            var projectId = configuration["Firebase:ProjectId"];
            if (!string.IsNullOrWhiteSpace(projectId)) options.ProjectId = projectId;
            var app = FirebaseApp.DefaultInstance ?? FirebaseApp.Create(options);
            _messaging = FirebaseMessaging.GetMessaging(app);
            _logger.LogInformation("Firebase push service initialized");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Firebase push initialization failed; core monitoring remains available");
        }
    }

    public async Task SendEventAsync(string eventType, string eventId, CancellationToken ct = default)
    {
        if (_messaging is null || !Content.TryGetValue(eventType, out var content)) return;

        var dedupeKey = $"{eventType}:{eventId}";
        var now = DateTime.UtcNow;
        if (_recentEvents.TryGetValue(dedupeKey, out var lastSent) && now - lastSent < TimeSpan.FromMinutes(1)) return;
        _recentEvents[dedupeKey] = now;
        foreach (var stale in _recentEvents.Where(x => now - x.Value > TimeSpan.FromHours(1)).Select(x => x.Key))
            _recentEvents.TryRemove(stale, out _);

        try
        {
            await using var scope = _scopeFactory.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var tokenRecords = await db.UserPushTokens
                .Where(x => x.IsActive)
                .OrderBy(x => x.Id)
                .ToListAsync(ct);
            if (tokenRecords.Count == 0) return;

            var messages = tokenRecords.Select(record => BuildMessage(record.Token, eventType, eventId, content)).ToList();
            var response = await _messaging.SendEachAsync(messages, ct);
            if (response.FailureCount == 0)
            {
                _logger.LogInformation("Push {EventType} sent to {Count} device(s)", eventType, response.SuccessCount);
                return;
            }

            for (var index = 0; index < response.Responses.Count; index++)
            {
                var result = response.Responses[index];
                if (result.IsSuccess) continue;
                _logger.LogWarning(result.Exception, "Push {EventType} failed for token record {TokenId}", eventType, tokenRecords[index].Id);
                if (result.Exception?.MessagingErrorCode is MessagingErrorCode.Unregistered or MessagingErrorCode.InvalidArgument)
                {
                    tokenRecords[index].IsActive = false;
                    tokenRecords[index].UpdatedAt = now;
                }
            }
            await db.SaveChangesAsync(ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Push {EventType} failed; MQTT, SQL and SignalR continue normally", eventType);
        }
    }

    private static Message BuildMessage(string token, string eventType, string eventId, PushContent content)
    {
#pragma warning disable CS0618 // Capacitor currently supplies an FCM registration token.
        return new Message
        {
            Token = token,
            Notification = new Notification { Title = content.Title, Body = content.Body },
            Data = new Dictionary<string, string>
            {
                ["eventId"] = eventId,
                ["eventType"] = eventType,
                ["route"] = "/"
            },
            Android = new AndroidConfig
            {
                Priority = Priority.High,
                Notification = new AndroidNotification
                {
                    ChannelId = content.ChannelId,
                    Sound = "default",
                    Tag = $"iot-fire-{eventId}"
                }
            }
        };
#pragma warning restore CS0618
    }

    private sealed record PushContent(string Title, string Body, string ChannelId);
}
