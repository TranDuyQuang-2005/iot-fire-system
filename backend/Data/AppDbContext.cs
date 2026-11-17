using IotFire.Api.Models;
using Microsoft.EntityFrameworkCore;

namespace IotFire.Api.Data;

public sealed class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<User> Users => Set<User>();
    public DbSet<Device> Devices => Set<Device>();
    public DbSet<SensorReading> SensorReadings => Set<SensorReading>();
    public DbSet<EventRecord> Events => Set<EventRecord>();
    public DbSet<Alert> Alerts => Set<Alert>();
    public DbSet<CommandRecord> Commands => Set<CommandRecord>();
    public DbSet<AuditLog> AuditLogs => Set<AuditLog>();
    public DbSet<UserPushToken> UserPushTokens => Set<UserPushToken>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<User>().Property(x => x.Username).HasMaxLength(100);
        modelBuilder.Entity<User>().Property(x => x.PasswordHash).HasMaxLength(500);
        modelBuilder.Entity<User>().Property(x => x.Role).HasMaxLength(30);
        modelBuilder.Entity<User>().HasIndex(x => x.Username).IsUnique();
        // 450 Unicode characters remain within SQL Server's index key limit.
        modelBuilder.Entity<UserPushToken>().Property(x => x.Token).HasMaxLength(450);
        modelBuilder.Entity<UserPushToken>().Property(x => x.Platform).HasMaxLength(30);
        modelBuilder.Entity<UserPushToken>().Property(x => x.DeviceName).HasMaxLength(200);
        modelBuilder.Entity<UserPushToken>().HasIndex(x => x.Token).IsUnique();
        modelBuilder.Entity<UserPushToken>().HasIndex(x => new { x.UserId, x.IsActive });
        modelBuilder.Entity<UserPushToken>()
            .HasOne(x => x.User)
            .WithMany(x => x.PushTokens)
            .HasForeignKey(x => x.UserId)
            .OnDelete(DeleteBehavior.Cascade);
        modelBuilder.Entity<Device>().Property(x => x.DeviceCode).HasMaxLength(100);
        modelBuilder.Entity<Device>().Property(x => x.Name).HasMaxLength(200);
        modelBuilder.Entity<Device>().Property(x => x.Status).HasMaxLength(20);
        modelBuilder.Entity<Device>().Property(x => x.CurrentState).HasMaxLength(30);
        modelBuilder.Entity<Device>().Property(x => x.CurrentMode).HasMaxLength(20);
        modelBuilder.Entity<Device>().HasIndex(x => x.DeviceCode).IsUnique();
        modelBuilder.Entity<SensorReading>().Property(x => x.SmokeLevel).HasMaxLength(30);
        modelBuilder.Entity<SensorReading>().Property(x => x.SystemState).HasMaxLength(30);
        modelBuilder.Entity<SensorReading>().Property(x => x.Mode).HasMaxLength(20);
        modelBuilder.Entity<SensorReading>().HasIndex(x => new { x.DeviceId, x.ReceivedAt });
        modelBuilder.Entity<EventRecord>().Property(x => x.EventType).HasMaxLength(100);
        modelBuilder.Entity<EventRecord>().Property(x => x.Severity).HasMaxLength(30);
        modelBuilder.Entity<EventRecord>().Property(x => x.State).HasMaxLength(30);
        modelBuilder.Entity<EventRecord>().Property(x => x.Message).HasMaxLength(1000);
        modelBuilder.Entity<EventRecord>().HasIndex(x => new { x.DeviceId, x.CreatedAt });
        modelBuilder.Entity<Alert>().Property(x => x.Type).HasMaxLength(100);
        modelBuilder.Entity<Alert>().Property(x => x.Severity).HasMaxLength(30);
        modelBuilder.Entity<Alert>().Property(x => x.Message).HasMaxLength(1000);
        modelBuilder.Entity<Alert>().HasIndex(x => new { x.DeviceId, x.CreatedAt });
        modelBuilder.Entity<CommandRecord>().Property(x => x.CommandId).HasMaxLength(64);
        modelBuilder.Entity<CommandRecord>().Property(x => x.CommandType).HasMaxLength(50);
        modelBuilder.Entity<CommandRecord>().Property(x => x.Status).HasMaxLength(30);
        modelBuilder.Entity<CommandRecord>().Property(x => x.Reason).HasMaxLength(500);
        modelBuilder.Entity<CommandRecord>().Property(x => x.RequestedBy).HasMaxLength(100);
        modelBuilder.Entity<CommandRecord>().HasIndex(x => x.CommandId).IsUnique();
    }
}
