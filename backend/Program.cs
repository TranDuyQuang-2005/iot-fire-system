using System.Text;
using IotFire.Api.Data;
using IotFire.Api.Hubs;
using IotFire.Api.Models;
using IotFire.Api.Services;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using Microsoft.OpenApi.Models;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddDbContext<AppDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Default")));

builder.Services.AddControllers().AddJsonOptions(options =>
    options.JsonSerializerOptions.Converters.Add(new UtcDateTimeJsonConverter()));
builder.Services.AddSignalR();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(options =>
{
    options.AddSecurityDefinition("Bearer", new OpenApiSecurityScheme
    {
        Name = "Authorization",
        Type = SecuritySchemeType.Http,
        Scheme = "bearer",
        BearerFormat = "JWT",
        In = ParameterLocation.Header,
        Description = "Enter the JWT returned by POST /api/auth/login"
    });
    options.AddSecurityRequirement(new OpenApiSecurityRequirement
    {
        [new OpenApiSecurityScheme
        {
            Reference = new OpenApiReference { Type = ReferenceType.SecurityScheme, Id = "Bearer" }
        }] = Array.Empty<string>()
    });
});
builder.Services.AddScoped<JwtTokenService>();
builder.Services.AddSingleton<IPushNotificationService, PushNotificationService>();

builder.Services.AddSingleton<MqttBackgroundService>();
builder.Services.AddSingleton<IIotCommandPublisher>(sp => sp.GetRequiredService<MqttBackgroundService>());
builder.Services.AddHostedService(sp => sp.GetRequiredService<MqttBackgroundService>());

var jwtKey = builder.Configuration["Jwt:Key"];
if (string.IsNullOrWhiteSpace(jwtKey) || jwtKey.Length < 32)
    throw new InvalidOperationException("Jwt:Key must be configured with at least 32 characters");
var jwtIssuer = builder.Configuration["Jwt:Issuer"] ?? "IotFire";
var jwtAudience = builder.Configuration["Jwt:Audience"] ?? "IotFireClient";

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidateAudience = true,
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,
            ValidIssuer = jwtIssuer,
            ValidAudience = jwtAudience,
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtKey))
        };

        // Cho SignalR nhận token qua query string.
        options.Events = new JwtBearerEvents
        {
            OnMessageReceived = context =>
            {
                var accessToken = context.Request.Query["access_token"];
                var path = context.HttpContext.Request.Path;
                if (!string.IsNullOrEmpty(accessToken) && path.StartsWithSegments("/iotHub"))
                    context.Token = accessToken;
                return Task.CompletedTask;
            }
        };
    });

builder.Services.AddAuthorization();
var allowedFrontendOrigins = new[]
{
    builder.Configuration["FrontendOrigin"] ?? "http://localhost:4200",
    "http://localhost",
    "https://localhost",
    "capacitor://localhost"
}.Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
builder.Services.AddCors(o => o.AddPolicy("frontend", p => p
    .WithOrigins(allowedFrontendOrigins)
    .AllowAnyHeader()
    .AllowAnyMethod()
    .AllowCredentials()));

var app = builder.Build();

app.UseSwagger();
app.UseSwaggerUI();
app.UseCors("frontend");
app.UseAuthentication();
app.UseAuthorization();
app.MapControllers();
app.MapHub<IotHub>("/iotHub");
app.MapGet("/health", () => Results.Ok(new { status = "healthy", timestamp = DateTime.UtcNow }));

const int databaseAttempts = 10;
for (var attempt = 1; attempt <= databaseAttempts; attempt++)
{
    try
    {
        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        await PrepareLegacyDatabaseForMigrationsAsync(db);
        await db.Database.MigrateAsync();

        var adminUsername = builder.Configuration["SeedAdmin:Username"] ?? "admin";
        if (!await db.Users.AnyAsync(x => x.Username == adminUsername))
        {
            var adminPassword = builder.Configuration["SeedAdmin:Password"];
            if (string.IsNullOrWhiteSpace(adminPassword))
                throw new InvalidOperationException("SeedAdmin:Password must be configured");

            var admin = new User { Username = adminUsername, Role = "ADMIN" };
            var hasher = new PasswordHasher<User>();
            admin.PasswordHash = hasher.HashPassword(admin, adminPassword);
            db.Users.Add(admin);
            await db.SaveChangesAsync();
        }

        app.Logger.LogInformation("Database initialized successfully");
        break;
    }
    catch (Exception ex) when (attempt < databaseAttempts)
    {
        app.Logger.LogWarning(ex, "Database initialization attempt {Attempt}/{Total} failed; retrying", attempt, databaseAttempts);
        await Task.Delay(TimeSpan.FromSeconds(3));
    }
}

app.Run();

static async Task PrepareLegacyDatabaseForMigrationsAsync(AppDbContext db)
{
    // Previous releases used EnsureCreated(), so deployed databases have tables but no
    // migration history. Baseline them once, then let normal EF migrations add new schema.
    if (!await db.Database.CanConnectAsync()) return;

    var connection = db.Database.GetDbConnection();
    await connection.OpenAsync();
    try
    {
        await using var probe = connection.CreateCommand();
        probe.CommandText = """
            SELECT CASE WHEN OBJECT_ID(N'[dbo].[Users]', N'U') IS NOT NULL THEN 1 ELSE 0 END,
                   CASE WHEN OBJECT_ID(N'[dbo].[__EFMigrationsHistory]', N'U') IS NOT NULL THEN 1 ELSE 0 END
            """;
        await using var reader = await probe.ExecuteReaderAsync();
        await reader.ReadAsync();
        var hasLegacySchema = reader.GetInt32(0) == 1;
        var hasMigrationHistory = reader.GetInt32(1) == 1;
        await reader.CloseAsync();
        if (!hasLegacySchema || hasMigrationHistory) return;

        await using var baseline = connection.CreateCommand();
        baseline.CommandText = """
            CREATE TABLE [dbo].[__EFMigrationsHistory] (
                [MigrationId] nvarchar(150) NOT NULL,
                [ProductVersion] nvarchar(32) NOT NULL,
                CONSTRAINT [PK___EFMigrationsHistory] PRIMARY KEY ([MigrationId])
            );
            INSERT INTO [dbo].[__EFMigrationsHistory] ([MigrationId], [ProductVersion])
            VALUES (N'20261117175557_InitialCreate', N'9.0.23');
            """;
        await baseline.ExecuteNonQueryAsync();
    }
    finally
    {
        await connection.CloseAsync();
    }
}
