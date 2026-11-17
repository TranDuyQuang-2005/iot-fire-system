using IotFire.Api.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace IotFire.Api.Controllers;

[ApiController]
[Route("api/events")]
[Authorize]
public sealed class EventsController(AppDbContext db) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Get(
        [FromQuery] string? deviceId,
        [FromQuery] string? eventType,
        [FromQuery] string? severity,
        [FromQuery] DateTime? from,
        [FromQuery] DateTime? to)
    {
        var q = db.Events.Include(x => x.Device).AsQueryable();
        if (!string.IsNullOrWhiteSpace(deviceId)) q = q.Where(x => x.Device!.DeviceCode == deviceId);
        if (!string.IsNullOrWhiteSpace(eventType)) q = q.Where(x => x.EventType == eventType);
        if (!string.IsNullOrWhiteSpace(severity)) q = q.Where(x => x.Severity == severity);
        if (from.HasValue) q = q.Where(x => x.CreatedAt >= from.Value);
        if (to.HasValue) q = q.Where(x => x.CreatedAt <= to.Value);
        return Ok(await q.OrderByDescending(x => x.CreatedAt).Take(500).ToListAsync());
    }

    [HttpGet("{id:long}")]
    public async Task<IActionResult> GetById(long id)
    {
        var item = await db.Events.Include(x => x.Device).SingleOrDefaultAsync(x => x.Id == id);
        return item is null ? NotFound() : Ok(item);
    }
}
