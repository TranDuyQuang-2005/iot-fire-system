using IotFire.Api.Data;
using IotFire.Api.DTOs;
using IotFire.Api.Services;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace IotFire.Api.Controllers;

[ApiController]
[Route("api/auth")]
public sealed class AuthController(AppDbContext db, JwtTokenService jwt) : ControllerBase
{
    [HttpPost("login")]
    public async Task<ActionResult<LoginResponse>> Login(LoginRequest request)
    {
        var user = await db.Users.SingleOrDefaultAsync(x => x.Username == request.Username);
        if (user is null) return Unauthorized(new { message = "Sai tài khoản hoặc mật khẩu" });

        var hasher = new PasswordHasher<IotFire.Api.Models.User>();
        var result = hasher.VerifyHashedPassword(user, user.PasswordHash, request.Password);
        if (result == PasswordVerificationResult.Failed)
            return Unauthorized(new { message = "Sai tài khoản hoặc mật khẩu" });

        var (token, expiresIn) = jwt.Create(user.Username, user.Role);
        return Ok(new LoginResponse(token, expiresIn, user.Role, user.Username));
    }
}
