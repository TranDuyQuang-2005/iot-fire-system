using IotFire.Api.Data;
using IotFire.Api.DTOs;
using IotFire.Api.Models;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace IotFire.Api.Controllers;

[ApiController]
[Route("api/push")]
[Authorize]
public sealed class PushController(AppDbContext db, ILogger<PushController> logger) : ControllerBase
{
    [HttpPost("register")]
    public async Task<IActionResult> Register(PushTokenRegisterRequest request, CancellationToken ct)
    {
        var username = User.Identity?.Name;
        if (string.IsNullOrWhiteSpace(username)) return Unauthorized();

        var user = await db.Users.SingleOrDefaultAsync(x => x.Username == username, ct);
        if (user is null) return Unauthorized();

        var tokenValue = request.Token.Trim();
        var token = await db.UserPushTokens.SingleOrDefaultAsync(x => x.Token == tokenValue, ct);
        var now = DateTime.UtcNow;

        if (token is null)
        {
            token = new UserPushToken
            {
                UserId = user.Id,
                Token = tokenValue,
                CreatedAt = now
            };
            db.UserPushTokens.Add(token);
        }
        else
        {
            // A refreshed/reinstalled app may present a token already known to the server.
            // Ownership follows the currently authenticated user; no client-supplied UserId is accepted.
            token.UserId = user.Id;
        }

        token.Platform = request.Platform.Trim().ToLowerInvariant();
        token.DeviceName = request.DeviceName.Trim();
        token.IsActive = true;
        token.UpdatedAt = now;
        token.LastSeenAt = now;
        await db.SaveChangesAsync(ct);
        logger.LogInformation(
            "FCM token record {TokenId} registered for user {Username} on {Platform}",
            token.Id,
            username,
            token.Platform);

        return Ok(new { registered = true, token.Id, token.Platform, token.DeviceName });
    }

    [HttpPost("unregister")]
    public async Task<IActionResult> Unregister(PushTokenUnregisterRequest request, CancellationToken ct)
    {
        var username = User.Identity?.Name;
        if (string.IsNullOrWhiteSpace(username)) return Unauthorized();

        var token = await db.UserPushTokens
            .Include(x => x.User)
            .SingleOrDefaultAsync(x => x.Token == request.Token.Trim() && x.User!.Username == username, ct);
        if (token is null) return Ok(new { unregistered = true });

        token.IsActive = false;
        token.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        logger.LogInformation("FCM token record {TokenId} deactivated for user {Username}", token.Id, username);
        return Ok(new { unregistered = true });
    }
}
