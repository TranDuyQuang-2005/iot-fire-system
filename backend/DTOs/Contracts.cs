using System.Text.Json.Serialization;
using System.ComponentModel.DataAnnotations;

namespace IotFire.Api.DTOs;

public sealed class LoginRequest
{
    [Required, StringLength(100)]
    public string Username { get; set; } = string.Empty;

    [Required, StringLength(200)]
    public string Password { get; set; } = string.Empty;
}
public sealed record LoginResponse(string AccessToken, int ExpiresIn, string Role, string Username);

public sealed class TelemetryDto
{
    [JsonRequired]
    public string DeviceId { get; set; } = string.Empty;
    [JsonRequired]
    public double? Temperature { get; set; }
    [JsonRequired]
    public double? Humidity { get; set; }
    [JsonRequired]
    public double TemperatureRate { get; set; }
    [JsonRequired]
    public int SmokeRaw { get; set; }
    [JsonRequired]
    public string SmokeLevel { get; set; } = "NORMAL";
    [JsonRequired]
    public bool FlameDetected { get; set; }
    [JsonRequired]
    public bool FlameConfirmed { get; set; }
    [JsonRequired]
    public string State { get; set; } = "NORMAL";
    [JsonRequired]
    public string Mode { get; set; } = "AUTO";
    [JsonRequired]
    public bool FanOn { get; set; }
    [JsonRequired]
    public bool PumpOn { get; set; }
    [JsonRequired]
    public bool BuzzerOn { get; set; }
    [JsonRequired]
    public bool DhtOk { get; set; }
    [JsonRequired]
    public int WifiRssi { get; set; }
    [JsonRequired]
    public long UptimeMs { get; set; }
}

public sealed class EventDto
{
    [JsonRequired]
    public string DeviceId { get; set; } = string.Empty;
    [JsonRequired]
    public string EventType { get; set; } = string.Empty;
    [JsonRequired]
    public string Severity { get; set; } = string.Empty;
    [JsonRequired]
    public string State { get; set; } = string.Empty;
    [JsonRequired]
    public string Message { get; set; } = string.Empty;
    [JsonRequired]
    public long UptimeMs { get; set; }
}

public sealed class CommandRequest
{
    [Required, StringLength(50)]
    public string Command { get; set; } = string.Empty;
}

public sealed class ModeRequest
{
    [Required, StringLength(20)]
    public string Mode { get; set; } = string.Empty;
}

public sealed class CommandResponseDto
{
    [JsonRequired]
    public string DeviceId { get; set; } = string.Empty;
    [JsonRequired]
    public string CommandId { get; set; } = string.Empty;
    [JsonRequired]
    public string Command { get; set; } = string.Empty;
    [JsonRequired]
    public string Status { get; set; } = string.Empty;
    public string? Reason { get; set; }
    public string? Message { get; set; }
}

public sealed class PushTokenRegisterRequest
{
    [Required, StringLength(450, MinimumLength = 20)]
    public string Token { get; set; } = string.Empty;

    [Required, StringLength(30)]
    public string Platform { get; set; } = "android";

    [StringLength(200)]
    public string DeviceName { get; set; } = string.Empty;
}

public sealed class PushTokenUnregisterRequest
{
    [Required, StringLength(450, MinimumLength = 20)]
    public string Token { get; set; } = string.Empty;
}
