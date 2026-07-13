using System.Security.Cryptography;
using System.Text;
using DbMigrator.Web.Models;
using DbMigrator.Web.Services;
using Microsoft.AspNetCore.Mvc;

namespace DbMigrator.Web.Controllers;

[ApiController]
[Route("api/auth")]
public sealed class AuthController : ControllerBase
{
    public const string SessionUserKey = "DbMigrator.AuthenticatedUser";

    private readonly AuthConfigService _authConfig;

    public AuthController(AuthConfigService authConfig)
    {
        _authConfig = authConfig;
    }

    [HttpGet("status")]
    public IActionResult Status()
    {
        var config = _authConfig.Get();
        var sessionUser = HttpContext.Session.GetString(SessionUserKey);
        return Ok(new
        {
            Success = true,
            LoginEnabled = config.LoginEnabled,
            IsAuthenticated = !config.LoginEnabled || sessionUser == config.Username,
            Username = sessionUser ?? ""
        });
    }

    [HttpPost("login")]
    public IActionResult Login([FromBody] LoginRequest request)
    {
        var config = _authConfig.Get();
        if (!config.LoginEnabled)
        {
            return Ok(new { Success = true, Message = "Login sedang dinonaktifkan." });
        }

        if (!SecureEquals(request.Username, config.Username) || !SecureEquals(request.Password, config.Password))
        {
            return Unauthorized(new { Success = false, Message = "Username atau password salah." });
        }

        HttpContext.Session.SetString(SessionUserKey, config.Username);
        return Ok(new { Success = true, Message = "Login berhasil.", Username = config.Username });
    }

    [HttpPost("logout")]
    public IActionResult Logout()
    {
        HttpContext.Session.Clear();
        return Ok(new { Success = true, Message = "Logout berhasil." });
    }

    [HttpGet("settings")]
    public IActionResult GetSettings()
    {
        var config = _authConfig.Get();
        return Ok(new
        {
            Success = true,
            config.LoginEnabled,
            config.Username,
            ConfigFile = "auth-config.json"
        });
    }

    [HttpPut("settings")]
    public IActionResult UpdateSettings([FromBody] UpdateAuthSettingsRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Username))
        {
            return BadRequest(new { Success = false, Message = "Username wajib diisi." });
        }

        if (request.Username.Trim().Length < 3)
        {
            return BadRequest(new { Success = false, Message = "Username minimal 3 karakter." });
        }

        if (!string.IsNullOrEmpty(request.Password) && request.Password.Length < 8)
        {
            return BadRequest(new { Success = false, Message = "Password baru minimal 8 karakter." });
        }

        var updated = _authConfig.Update(request.LoginEnabled, request.Username, request.Password);
        HttpContext.Session.SetString(SessionUserKey, updated.Username);

        return Ok(new
        {
            Success = true,
            Message = "Pengaturan login berhasil disimpan ke auth-config.json.",
            updated.LoginEnabled,
            updated.Username
        });
    }

    private static bool SecureEquals(string? left, string? right)
    {
        var leftBytes = Encoding.UTF8.GetBytes(left ?? "");
        var rightBytes = Encoding.UTF8.GetBytes(right ?? "");
        return leftBytes.Length == rightBytes.Length
            && CryptographicOperations.FixedTimeEquals(leftBytes, rightBytes);
    }
}
