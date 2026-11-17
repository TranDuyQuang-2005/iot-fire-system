using System.Security.Claims;
using IotFire.Api.Data;
using IotFire.Api.DTOs;
using IotFire.Api.Models;
using IotFire.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace IotFire.Api.Controllers;

[ApiController]
[Route("api/devices")]
[Authorize]
public sealed class DevicesController(
    AppDbContext db,
    IIotCommandPublisher publisher,
    IConfiguration configuration,
    ILogger<DevicesController> logger) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> GetDevices() =>
        Ok(await db.Devices.OrderBy(x => x.DeviceCode).ToListAsync());

    [HttpGet("{deviceCode}")]
    public async Task<IActionResult> GetDevice(string deviceCode)
    {
        var device = await db.Devices.SingleOrDefaultAsync(x => x.DeviceCode == deviceCode);
        return device is null ? NotFound() : Ok(device);
    }

    [HttpGet("{deviceCode}/latest")]
    public async Task<IActionResult> GetLatest(string deviceCode)
    {
        var device = await db.Devices.SingleOrDefaultAsync(x => x.DeviceCode == deviceCode);
        if (device is null) return NotFound();

        var reading = await db.SensorReadings
            .Where(x => x.DeviceId == device.Id)
            .OrderByDescending(x => x.ReceivedAt)
            .FirstOrDefaultAsync();

        return Ok(new { device, reading });
    }

    [HttpGet("{deviceCode}/readings")]
    public async Task<IActionResult> GetReadings(
        string deviceCode,
        [FromQuery] DateTime? from,
        [FromQuery] DateTime? to,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 100)
    {
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 1, 500);
        var device = await db.Devices.SingleOrDefaultAsync(x => x.DeviceCode == deviceCode);
        if (device is null) return NotFound();

        var q = db.SensorReadings.Where(x => x.DeviceId == device.Id);
        if (from.HasValue) q = q.Where(x => x.ReceivedAt >= from.Value);
        if (to.HasValue) q = q.Where(x => x.ReceivedAt <= to.Value);

        var total = await q.CountAsync();
        var items = await q.OrderByDescending(x => x.ReceivedAt)
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .ToListAsync();
        return Ok(new { total, page, pageSize, items });
    }

    [HttpPost("{deviceCode}/commands")]
    [Authorize(Roles = "ADMIN")]
    public async Task<IActionResult> SendCommand(string deviceCode, CommandRequest request, CancellationToken ct)
    {
        var allowed = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "FAN_ON", "FAN_OFF", "PUMP_ON", "PUMP_OFF", "BUZZER_ON", "BUZZER_OFF",
            "SET_AUTO_MODE", "SET_MANUAL_MODE", "RESET_ALARM"
        };
        var commandType = request.Command?.Trim().ToUpperInvariant() ?? string.Empty;
        if (!allowed.Contains(commandType)) return BadRequest(new { message = "Command không hợp lệ" });

        var device = await db.Devices.SingleOrDefaultAsync(x => x.DeviceCode == deviceCode, ct);
        if (device is null) return NotFound();

        var offlineSeconds = int.TryParse(configuration["DeviceOfflineSeconds"], out var timeout) ? timeout : 10;
        var isStale = !device.LastSeen.HasValue || device.LastSeen.Value < DateTime.UtcNow.AddSeconds(-offlineSeconds);
        if (device.Status != "ONLINE" || isStale)
            return Conflict(new { code = "DEVICE_OFFLINE", message = "Không thể điều khiển khi thiết bị offline" });

        if (commandType == "FAN_ON" &&
            device.CurrentState is "FIRE" or "SUPPRESSING" or "HIGH_RISK" or "WARNING")
            return Conflict(new { code = "FAN_ON_NOT_ALLOWED_DURING_SAFETY_STATE" });
        if (commandType == "PUMP_OFF" && device.CurrentState is "FIRE" or "SUPPRESSING")
            return Conflict(new { code = "PUMP_OFF_NOT_ALLOWED_DURING_FIRE" });
        if (commandType == "PUMP_ON" && device.CurrentState != "NORMAL")
            return Conflict(new { code = "PUMP_ON_ONLY_ALLOWED_IN_NORMAL" });
        if ((commandType is "BUZZER_ON" or "BUZZER_OFF") && device.CurrentMode != "MANUAL")
            return Conflict(new
            {
                code = "BUZZER_MANUAL_MODE_REQUIRED",
                message = "Chuyển sang MANUAL để điều khiển còi"
            });
        if (commandType == "BUZZER_OFF" && device.CurrentState is "HIGH_RISK" or "FIRE" or "SUPPRESSING")
            return Conflict(new
            {
                code = "BUZZER_OFF_NOT_ALLOWED_DURING_SAFETY_STATE",
                message = $"Cannot disable buzzer during {device.CurrentState}"
            });
        if (commandType == "BUZZER_OFF" && device.CurrentState == "POST_FIRE")
            return Conflict(new
            {
                code = "BUZZER_OFF_NOT_ALLOWED_DURING_POST_FIRE",
                message = "Cannot disable buzzer during POST_FIRE; RESET_ALARM is required"
            });

        var record = new CommandRecord
        {
            DeviceId = device.Id,
            CommandType = commandType,
            Status = "SENT",
            RequestedBy = User.Identity?.Name ?? "unknown"
        };
        db.Commands.Add(record);
        await db.SaveChangesAsync(ct);

        try
        {
            await publisher.PublishCommandAsync(deviceCode, record.CommandId, record.CommandType, ct);
            return Accepted(new { record.CommandId, record.Status, record.CommandType });
        }
        catch (Exception ex)
        {
            record.Status = "FAILED";
            record.Reason = "MQTT broker is unavailable";
            await db.SaveChangesAsync(ct);
            logger.LogError(ex, "Failed to publish command {CommandId} to {DeviceCode}", record.CommandId, deviceCode);
            return StatusCode(503, new { message = "MQTT unavailable", record.CommandId });
        }
    }

    [HttpPut("{deviceCode}/mode")]
    [Authorize(Roles = "ADMIN")]
    public Task<IActionResult> SetMode(string deviceCode, ModeRequest request, CancellationToken ct)
    {
        var command = request.Mode.Equals("AUTO", StringComparison.OrdinalIgnoreCase)
            ? "SET_AUTO_MODE"
            : request.Mode.Equals("MANUAL", StringComparison.OrdinalIgnoreCase)
                ? "SET_MANUAL_MODE"
                : string.Empty;

        if (string.IsNullOrEmpty(command)) return Task.FromResult<IActionResult>(BadRequest(new { message = "Mode phải là AUTO hoặc MANUAL" }));
        return SendCommand(deviceCode, new CommandRequest { Command = command }, ct);
    }

    [HttpPost("{deviceCode}/reset-alarm")]
    [Authorize(Roles = "ADMIN")]
    public Task<IActionResult> ResetAlarm(string deviceCode, CancellationToken ct) =>
        SendCommand(deviceCode, new CommandRequest { Command = "RESET_ALARM" }, ct);
}
