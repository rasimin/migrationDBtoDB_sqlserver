using System.Text.Json;

namespace DbMigrator.Web.Services;

public sealed class AuthConfigService
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = true
    };

    private readonly string _filePath;
    private readonly object _syncRoot = new();

    public AuthConfigService(IWebHostEnvironment environment)
    {
        _filePath = Path.Combine(environment.ContentRootPath, "auth-config.json");
        EnsureConfigExists();
    }

    public AuthConfig Get()
    {
        lock (_syncRoot)
        {
            return ReadConfig();
        }
    }

    public AuthConfig Update(bool loginEnabled, string username, string? password)
    {
        lock (_syncRoot)
        {
            var current = ReadConfig();
            current.LoginEnabled = loginEnabled;
            current.Username = username.Trim();

            if (!string.IsNullOrWhiteSpace(password))
            {
                current.Password = password;
            }

            WriteConfig(current);
            return current;
        }
    }

    private void EnsureConfigExists()
    {
        lock (_syncRoot)
        {
            if (!File.Exists(_filePath))
            {
                WriteConfig(new AuthConfig());
            }
        }
    }

    private AuthConfig ReadConfig()
    {
        var json = File.ReadAllText(_filePath);
        var config = JsonSerializer.Deserialize<AuthConfig>(json, JsonOptions)
            ?? throw new InvalidOperationException("Isi auth-config.json tidak valid.");

        if (string.IsNullOrWhiteSpace(config.Username) || string.IsNullOrEmpty(config.Password))
        {
            throw new InvalidOperationException("Username dan Password pada auth-config.json wajib diisi.");
        }

        return config;
    }

    private void WriteConfig(AuthConfig config)
    {
        var tempPath = _filePath + ".tmp";
        File.WriteAllText(tempPath, JsonSerializer.Serialize(config, JsonOptions));
        File.Move(tempPath, _filePath, true);
    }
}

public sealed class AuthConfig
{
    public bool LoginEnabled { get; set; } = true;
    public string Username { get; set; } = "admin_r7m4";
    public string Password { get; set; } = "QNB!9vK2xL6p";
}
