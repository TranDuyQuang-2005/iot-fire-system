namespace IotFire.Api.Models;

public sealed class User
{
    public int Id { get; set; }
    public string Username { get; set; } = string.Empty;
    public string PasswordHash { get; set; } = string.Empty;
    public string Role { get; set; } = "USER";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public ICollection<UserPushToken> PushTokens { get; set; } = new List<UserPushToken>();
}

public sealed class UserPushToken
{
    public long Id { get; set; }
    public int UserId { get; set; }
    public User? User { get; set; }
    public string Token { get; set; } = string.Empty;
    public string Platform { get; set; } = "android";
    public string DeviceName { get; set; } = string.Empty;
    public bool IsActive { get; set; } = true;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public DateTime LastSeenAt { get; set; } = DateTime.UtcNow;
}

public sealed class Device
{
    public int Id { get; set; }
    public string DeviceCode { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Status { get; set; } = "OFFLINE";
    public string CurrentState { get; set; } = "NORMAL";
    public string CurrentMode { get; set; } = "AUTO";
    public DateTime? LastSeen { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class SensorReading
{
    public long Id { get; set; }
    public int DeviceId { get; set; }
    public Device? Device { get; set; }
    public double? Temperature { get; set; }
    public double? Humidity { get; set; }
    public double TemperatureRate { get; set; }
    public int SmokeRaw { get; set; }
    public string SmokeLevel { get; set; } = "NORMAL";
    public bool FlameDetected { get; set; }
    public bool FlameConfirmed { get; set; }
    public string SystemState { get; set; } = "NORMAL";
    public string Mode { get; set; } = "AUTO";
    public bool FanOn { get; set; }
    public bool PumpOn { get; set; }
    public bool BuzzerOn { get; set; }
    public bool DhtOk { get; set; }
    public int WifiRssi { get; set; }
    public long UptimeMs { get; set; }
    public DateTime ReceivedAt { get; set; } = DateTime.UtcNow;
}

public sealed class EventRecord
{
    public long Id { get; set; }
    public int DeviceId { get; set; }
    public Device? Device { get; set; }
    public string EventType { get; set; } = string.Empty;
    public string Severity { get; set; } = string.Empty;
    public string State { get; set; } = string.Empty;
    public string Message { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class Alert
{
    public long Id { get; set; }
    public int DeviceId { get; set; }
    public Device? Device { get; set; }
    public string Type { get; set; } = string.Empty;
    public string Severity { get; set; } = string.Empty;
    public string Message { get; set; } = string.Empty;
    public bool IsAcknowledged { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? AcknowledgedAt { get; set; }
    public string? AcknowledgedBy { get; set; }
}

public sealed class CommandRecord
{
    public long Id { get; set; }
    public string CommandId { get; set; } = Guid.NewGuid().ToString("N");
    public int DeviceId { get; set; }
    public Device? Device { get; set; }
    public string CommandType { get; set; } = string.Empty;
    public string Status { get; set; } = "PENDING";
    public string? Reason { get; set; }
    public string RequestedBy { get; set; } = string.Empty;
    public DateTime RequestedAt { get; set; } = DateTime.UtcNow;
    public DateTime? ExecutedAt { get; set; }
}

public sealed class AuditLog
{
    public long Id { get; set; }
    public string Actor { get; set; } = string.Empty;
    public string Action { get; set; } = string.Empty;
    public string Detail { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
