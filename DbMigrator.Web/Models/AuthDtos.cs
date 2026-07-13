namespace DbMigrator.Web.Models;

public sealed class LoginRequest
{
    public string Username { get; set; } = "";
    public string Password { get; set; } = "";
}

public sealed class UpdateAuthSettingsRequest
{
    public bool LoginEnabled { get; set; }
    public string Username { get; set; } = "";
    public string? Password { get; set; }
}
