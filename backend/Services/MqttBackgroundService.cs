using System.Net.Security;
using System.Text;
using System.Text.Json;
using IotFire.Api.Data;
using IotFire.Api.DTOs;
using IotFire.Api.Hubs;
using IotFire.Api.Models;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using MQTTnet;
using MQTTnet.Client;

namespace IotFire.Api.Services;

public interface IIotCommandPublisher
{
    Task PublishCommandAsync(string deviceCode, string commandId, string command, CancellationToken ct = default);
}

public sealed class MqttBackgroundService : BackgroundService, IIotCommandPublisher
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly IHubContext<IotHub> _hub;
    private readonly IConfiguration _config;
    private readonly ILogger<MqttBackgroundService> _logger;
    private readonly IPushNotificationService _push;
    private readonly IMqttClient _client;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };
    private static readonly HashSet<string> ValidStates = new(StringComparer.Ordinal)
    {
        "NORMAL", "HOT", "WARNING", "HIGH_RISK", "FIRE", "SUPPRESSING", "POST_FIRE"
    };
    private static readonly HashSet<string> ValidSmokeLevels = new(StringComparer.Ordinal)
    {
        "NORMAL", "WARNING", "CRITICAL"
    };

    public MqttBackgroundService(
        IServiceScopeFactory scopeFactory,
        IHubContext<IotHub> hub,
        IConfiguration config,
        IPushNotificationService push,
        ILogger<MqttBackgroundService> logger)
    {
        _scopeFactory = scopeFactory;
        _hub = hub;
        _config = config;
        _push = push;
        _logger = logger;
        _client = new MqttFactory().CreateMqttClient();

        _client.ApplicationMessageReceivedAsync += HandleMessageAsync;
        _client.DisconnectedAsync += args =>
        {
            _logger.LogWarning("MQTT disconnected: {Reason}", args.Reason);
            return Task.CompletedTask;
        };
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if (!_client.IsConnected)
                    await ConnectAsync(stoppingToken);

                await MarkOfflineDevicesAsync(stoppingToken);
                await MarkTimedOutCommandsAsync(stoppingToken);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "MQTT/monitoring iteration failed; service will retry");
            }

            await Task.Delay(3000, stoppingToken);
        }
    }

    private async Task ConnectAsync(CancellationToken ct)
    {
        var mode = _config["Mqtt:Mode"] ?? "local";
        var host = _config["Mqtt:Host"] ?? "localhost";
        var port = int.TryParse(_config["Mqtt:Port"], out var p) ? p : 1883;
        var useTls = bool.TryParse(_config["Mqtt:UseTls"], out var tls) && tls;
        var user = _config["Mqtt:Username"];
        var pass = _config["Mqtt:Password"];

        if (mode.Equals("cloud", StringComparison.OrdinalIgnoreCase) && !useTls)
            throw new InvalidOperationException("MQTT cloud mode requires TLS");

        var builder = new MqttClientOptionsBuilder()
            .WithClientId("iot-fire-backend")
            .WithTcpServer(host, port)
            .WithCleanSession();

        if (!string.IsNullOrWhiteSpace(user)) builder.WithCredentials(user, pass);

        if (useTls)
        {
            builder.WithTlsOptions(options =>
            {
                options.UseTls();
                // Keep certificate and hostname validation strict. Public cloud brokers
                // are validated against the container operating system trust store.
                options.WithCertificateValidationHandler(context =>
                    context.SslPolicyErrors == SslPolicyErrors.None);
            });
        }

        await _client.ConnectAsync(builder.Build(), ct);
        await _client.SubscribeAsync("iot/fire/device/+/telemetry", cancellationToken: ct);
        await _client.SubscribeAsync("iot/fire/device/+/event", cancellationToken: ct);
        await _client.SubscribeAsync("iot/fire/device/+/command-response", cancellationToken: ct);
        _logger.LogInformation("MQTT connected to {Host}:{Port} (mode: {Mode}, TLS: {UseTls})", host, port, mode, useTls);
        _logger.LogInformation("MQTT subscribed to telemetry, event and command-response topics");
    }

    private async Task HandleMessageAsync(MqttApplicationMessageReceivedEventArgs args)
    {
        try
        {
            var topic = args.ApplicationMessage.Topic;
            var seg = args.ApplicationMessage.PayloadSegment;
            var payload = seg.Array is null ? string.Empty : Encoding.UTF8.GetString(seg.Array, seg.Offset, seg.Count);

            // Telemetry, events and command responses are transient. Replaying a retained
            // payload would make an offline device appear online and could duplicate alerts.
            if (args.ApplicationMessage.Retain)
            {
                _logger.LogWarning("Ignored retained transient MQTT message on {Topic}", topic);
                return;
            }

            var topicDeviceCode = GetTopicDeviceCode(topic);
            if (topicDeviceCode is null)
            {
                _logger.LogWarning("Ignored MQTT message with invalid topic {Topic}", topic);
                return;
            }

            if (topic.EndsWith("/telemetry", StringComparison.Ordinal))
                await HandleTelemetryAsync(topicDeviceCode, payload);
            else if (topic.EndsWith("/event", StringComparison.Ordinal))
                await HandleEventAsync(topicDeviceCode, payload);
            else if (topic.EndsWith("/command-response", StringComparison.Ordinal))
                await HandleCommandResponseAsync(topicDeviceCode, payload);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed processing MQTT message on {Topic}", args.ApplicationMessage.Topic);
        }
    }

    private static string? GetTopicDeviceCode(string topic)
    {
        var parts = topic.Split('/', StringSplitOptions.RemoveEmptyEntries);
        return parts.Length == 5 && parts[0] == "iot" && parts[1] == "fire" && parts[2] == "device"
            ? parts[3]
            : null;
    }

    private async Task<Device> UpsertDeviceAsync(AppDbContext db, string deviceCode)
    {
        var device = await db.Devices.SingleOrDefaultAsync(x => x.DeviceCode == deviceCode);
        if (device is null)
        {
            device = new Device { DeviceCode = deviceCode, Name = deviceCode, Status = "OFFLINE" };
            db.Devices.Add(device);
            await db.SaveChangesAsync();
        }
        return device;
    }

    private async Task HandleTelemetryAsync(string topicDeviceCode, string payload)
    {
        var dto = JsonSerializer.Deserialize<TelemetryDto>(payload, JsonOptions);
        if (dto is null || string.IsNullOrWhiteSpace(dto.DeviceId))
        {
            _logger.LogWarning("Ignored telemetry without deviceId on {DeviceCode}", topicDeviceCode);
            return;
        }
        if (!string.Equals(dto.DeviceId, topicDeviceCode, StringComparison.Ordinal))
        {
            _logger.LogWarning("Ignored telemetry: topic device {TopicDevice} differs from payload device {PayloadDevice}", topicDeviceCode, dto.DeviceId);
            return;
        }
        if (dto.DeviceId.Length > 100 || !ValidStates.Contains(dto.State) ||
            dto.Mode is not ("AUTO" or "MANUAL") || !ValidSmokeLevels.Contains(dto.SmokeLevel))
        {
            _logger.LogWarning("Ignored telemetry with invalid contract values from {DeviceCode}", topicDeviceCode);
            return;
        }

        await using var scope = _scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var device = await UpsertDeviceAsync(db, dto.DeviceId);
        var wasOnline = device.Status == "ONLINE";
        var receivedAt = DateTime.UtcNow;

        device.Status = "ONLINE";
        device.LastSeen = receivedAt;
        device.CurrentState = dto.State;
        device.CurrentMode = dto.Mode;
        device.UpdatedAt = receivedAt;

        var reading = new SensorReading
        {
            DeviceId = device.Id,
            Temperature = dto.Temperature,
            Humidity = dto.Humidity,
            TemperatureRate = dto.TemperatureRate,
            SmokeRaw = dto.SmokeRaw,
            SmokeLevel = dto.SmokeLevel,
            FlameDetected = dto.FlameDetected,
            FlameConfirmed = dto.FlameConfirmed,
            SystemState = dto.State,
            Mode = dto.Mode,
            FanOn = dto.FanOn,
            PumpOn = dto.PumpOn,
            BuzzerOn = dto.BuzzerOn,
            DhtOk = dto.DhtOk,
            WifiRssi = dto.WifiRssi,
            UptimeMs = dto.UptimeMs,
            ReceivedAt = receivedAt
        };
        db.SensorReadings.Add(reading);

        await db.SaveChangesAsync();
        await _hub.Clients.All.SendAsync("TelemetryUpdated", new
        {
            reading.Id,
            dto.DeviceId,
            dto.Temperature,
            dto.Humidity,
            dto.TemperatureRate,
            dto.SmokeRaw,
            dto.SmokeLevel,
            dto.FlameDetected,
            dto.FlameConfirmed,
            dto.State,
            systemState = dto.State,
            dto.Mode,
            dto.FanOn,
            dto.PumpOn,
            dto.BuzzerOn,
            dto.DhtOk,
            dto.WifiRssi,
            dto.UptimeMs,
            receivedAt,
            lastSeen = receivedAt,
            status = "ONLINE"
        });

        if (!wasOnline)
        {
            _logger.LogInformation("Device {DeviceCode} is ONLINE", device.DeviceCode);
            await _hub.Clients.All.SendAsync("DeviceConnectionChanged", new
            {
                deviceId = device.DeviceCode,
                status = "ONLINE",
                online = true,
                lastSeen = receivedAt
            });
            await _push.SendEventAsync("DEVICE_ONLINE", $"online-{device.Id}-{receivedAt.Ticks}");
        }
    }

    private async Task HandleEventAsync(string topicDeviceCode, string payload)
    {
        var dto = JsonSerializer.Deserialize<EventDto>(payload, JsonOptions);
        if (dto is null || string.IsNullOrWhiteSpace(dto.DeviceId)) return;
        if (!string.Equals(dto.DeviceId, topicDeviceCode, StringComparison.Ordinal))
        {
            _logger.LogWarning("Ignored event with mismatched deviceId on {DeviceCode}", topicDeviceCode);
            return;
        }

        await using var scope = _scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var device = await UpsertDeviceAsync(db, dto.DeviceId);
        var previousEventType = await db.Events
            .Where(x => x.DeviceId == device.Id)
            .OrderByDescending(x => x.Id)
            .Select(x => x.EventType)
            .FirstOrDefaultAsync();

        var eventRecord = new EventRecord
        {
            DeviceId = device.Id,
            EventType = dto.EventType,
            Severity = dto.Severity,
            State = dto.State,
            Message = dto.Message
        };
        db.Events.Add(eventRecord);

        if (dto.Severity is "CRITICAL" or "HIGH" or "WARNING")
        {
            db.Alerts.Add(new Alert
            {
                DeviceId = device.Id,
                Type = dto.EventType,
                Severity = dto.Severity,
                Message = dto.Message
            });
        }

        await db.SaveChangesAsync();
        var realtimeEvent = new
        {
            eventId = eventRecord.Id.ToString(),
            dto.DeviceId,
            dto.EventType,
            dto.Severity,
            dto.State,
            dto.Message,
            dto.UptimeMs,
            eventRecord.CreatedAt
        };
        await _hub.Clients.All.SendAsync("DeviceStateChanged", realtimeEvent);
        await _hub.Clients.All.SendAsync("AlertCreated", realtimeEvent);
        if (dto.EventType == "FIRE_DETECTED")
            await _hub.Clients.All.SendAsync("FireDetected", realtimeEvent);

        var pushEventType = dto.EventType switch
        {
            "SMOKE_WARNING" => "WARNING",
            "HIGH_RISK" => "HIGH_RISK",
            "FIRE_DETECTED" => "FIRE",
            "FIRE_SUPPRESSING" => "SUPPRESSING",
            "FIRE_CLEARED" => "POST_FIRE",
            _ => null
        };
        // Firmware events are persisted as received, but repeated identical state events
        // must not produce a new phone notification on every publish.
        if (pushEventType is not null && !string.Equals(previousEventType, dto.EventType, StringComparison.Ordinal))
            await _push.SendEventAsync(pushEventType, eventRecord.Id.ToString());
    }

    private async Task HandleCommandResponseAsync(string topicDeviceCode, string payload)
    {
        var dto = JsonSerializer.Deserialize<CommandResponseDto>(payload, JsonOptions);
        if (dto is null || string.IsNullOrWhiteSpace(dto.CommandId)) return;
        if (!string.Equals(dto.DeviceId, topicDeviceCode, StringComparison.Ordinal))
        {
            _logger.LogWarning("Ignored command response with mismatched deviceId on {DeviceCode}", topicDeviceCode);
            return;
        }

        await using var scope = _scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var command = await db.Commands.Include(x => x.Device).SingleOrDefaultAsync(x => x.CommandId == dto.CommandId);
        var normalizedStatus = dto.Status.Equals("EXECUTED", StringComparison.OrdinalIgnoreCase)
            ? "ACKNOWLEDGED"
            : dto.Status.ToUpperInvariant();
        var responseReason = dto.Reason ?? dto.Message;
        if (normalizedStatus is not ("ACKNOWLEDGED" or "REJECTED" or "FAILED"))
        {
            _logger.LogWarning("Ignored invalid command status {Status} for {CommandId}", dto.Status, dto.CommandId);
            return;
        }
        if (command is not null)
        {
            if (!string.Equals(command.Device?.DeviceCode, topicDeviceCode, StringComparison.Ordinal))
            {
                _logger.LogWarning("Ignored command response {CommandId} from wrong device {DeviceCode}", dto.CommandId, topicDeviceCode);
                return;
            }
            command.Status = normalizedStatus;
            command.Reason = responseReason;
            command.ExecutedAt = DateTime.UtcNow;
            await db.SaveChangesAsync();
            _logger.LogInformation("Command {CommandId} {Status} by {DeviceCode}", dto.CommandId, normalizedStatus, topicDeviceCode);
        }
        else
        {
            _logger.LogWarning("Command response references unknown command {CommandId}", dto.CommandId);
            return;
        }

        await _hub.Clients.All.SendAsync("CommandStatusChanged", new
        {
            dto.DeviceId,
            dto.CommandId,
            dto.Command,
            status = normalizedStatus,
            reason = responseReason
        });
    }

    private async Task MarkOfflineDevicesAsync(CancellationToken ct)
    {
        var timeoutSeconds = int.TryParse(_config["DeviceOfflineSeconds"], out var s) ? s : 10;
        var cutoff = DateTime.UtcNow.AddSeconds(-timeoutSeconds);

        await using var scope = _scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var devices = await db.Devices.Where(x => x.Status == "ONLINE" && x.LastSeen < cutoff).ToListAsync(ct);
        var offlineEvents = new Dictionary<int, EventRecord>();
        foreach (var d in devices)
        {
            d.Status = "OFFLINE";
            d.UpdatedAt = DateTime.UtcNow;
            var offlineEvent = new EventRecord
            {
                DeviceId = d.Id,
                EventType = "DEVICE_OFFLINE",
                Severity = "WARNING",
                State = d.CurrentState,
                Message = "No telemetry within timeout"
            };
            db.Events.Add(offlineEvent);
            offlineEvents[d.Id] = offlineEvent;
        }
        if (devices.Count > 0)
        {
            await db.SaveChangesAsync(ct);
            foreach (var d in devices)
            {
                _logger.LogWarning("Device {DeviceCode} is OFFLINE; last seen {LastSeen}", d.DeviceCode, d.LastSeen);
                await _hub.Clients.All.SendAsync("DeviceConnectionChanged", new
                {
                    deviceId = d.DeviceCode,
                    status = "OFFLINE",
                    online = false,
                    lastSeen = d.LastSeen
                }, ct);
                await _push.SendEventAsync("DEVICE_OFFLINE", offlineEvents[d.Id].Id.ToString(), ct);
            }
        }
    }

    private async Task MarkTimedOutCommandsAsync(CancellationToken ct)
    {
        var timeoutSeconds = int.TryParse(_config["CommandTimeoutSeconds"], out var s) ? s : 15;
        var cutoff = DateTime.UtcNow.AddSeconds(-timeoutSeconds);

        await using var scope = _scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var commands = await db.Commands
            .Include(x => x.Device)
            .Where(x => (x.Status == "SENT" || x.Status == "PENDING") && x.RequestedAt < cutoff)
            .ToListAsync(ct);

        if (commands.Count == 0) return;
        foreach (var command in commands)
        {
            command.Status = "TIMEOUT";
            command.Reason = "No command response received before timeout";
            command.ExecutedAt = DateTime.UtcNow;
        }
        await db.SaveChangesAsync(ct);

        foreach (var command in commands)
        {
            _logger.LogWarning("Command {CommandId} timed out", command.CommandId);
            await _hub.Clients.All.SendAsync("CommandStatusChanged", new
            {
                deviceId = command.Device?.DeviceCode,
                commandId = command.CommandId,
                command = command.CommandType,
                status = command.Status,
                reason = command.Reason
            }, ct);
        }
    }

    public async Task PublishCommandAsync(string deviceCode, string commandId, string command, CancellationToken ct = default)
    {
        if (!_client.IsConnected) throw new InvalidOperationException("MQTT broker is offline");

        var payload = JsonSerializer.Serialize(new { commandId, command });
        var message = new MqttApplicationMessageBuilder()
            .WithTopic($"iot/fire/device/{deviceCode}/command")
            .WithPayload(payload)
            .WithQualityOfServiceLevel(MQTTnet.Protocol.MqttQualityOfServiceLevel.AtLeastOnce)
            .Build();

        await _client.PublishAsync(message, ct);
        _logger.LogInformation("Command {CommandId} ({Command}) sent to {DeviceCode}", commandId, command, deviceCode);
    }
}
