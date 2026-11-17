using IotFire.Api.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace IotFire.Api.Controllers;

[ApiController]
[Route("api/alerts")]
[Authorize]
public sealed class AlertsController(AppDbContext db) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Get() =>
        Ok(await db.Alerts.Include(x => x.Device).OrderByDescending(x => x.CreatedAt).Take(500).ToListAsync());

    [HttpPost("{id:long}/acknowledge")]
    public async Task<IActionResult> Acknowledge(long id)
    {
        var alert = await db.Alerts.FindAsync(id);
        if (alert is null) return NotFound();
        alert.IsAcknowledged = true;
        alert.AcknowledgedAt = DateTime.UtcNow;
        alert.AcknowledgedBy = User.Identity?.Name;
        await db.SaveChangesAsync();
        return Ok(alert);
    }

    [HttpPut("{id:long}/acknowledge")]
    [ApiExplorerSettings(IgnoreApi = true)]
    public Task<IActionResult> AcknowledgeLegacy(long id) => Acknowledge(id);
}
