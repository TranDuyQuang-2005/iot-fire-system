using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace IotFire.Api.Hubs;

[Authorize]
public sealed class IotHub : Hub
{
}
