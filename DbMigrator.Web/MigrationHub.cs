using Microsoft.AspNetCore.SignalR;
using System.Threading.Tasks;

namespace DbMigrator.Web
{
    public class MigrationHub : Hub
    {
        // SignalR Hub untuk real-time update progres migrasi
        public async Task JoinJobGroup(string jobId)
        {
            await Groups.AddToGroupAsync(Context.ConnectionId, "JobGroup_" + jobId);
        }
    }
}
