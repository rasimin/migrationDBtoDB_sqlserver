using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using DbMigrator.Web.Models;
using DbMigrator.Web.Services;

namespace DbMigrator.Web.Controllers
{
    [ApiController]
    [Route("api/ssrs")]
    public class SsrsController : ControllerBase
    {
        private readonly SsrsService _ssrsService;

        public SsrsController(SsrsService ssrsService)
        {
            _ssrsService = ssrsService;
        }

        [HttpGet("connections")]
        public async Task<IActionResult> GetSavedConnections()
        {
            try
            {
                var connections = await _ssrsService.GetSavedSsrsConnectionsAsync();
                return Ok(connections);
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = $"Gagal mengambil daftar koneksi SSRS: {ex.Message}" });
            }
        }

        [HttpPost("connections")]
        public async Task<IActionResult> SaveSavedConnection([FromBody] SavedSsrsConnection request)
        {
            if (string.IsNullOrEmpty(request?.ConnectionName) || string.IsNullOrEmpty(request?.Url))
            {
                return BadRequest(new { Success = false, Message = "Nama Koneksi dan URL tidak boleh kosong" });
            }

            try
            {
                var id = await _ssrsService.SaveSavedSsrsConnectionAsync(request);
                return Ok(new { Success = true, Message = "Koneksi SSRS berhasil disimpan/diperbarui", Id = id });
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = $"Gagal menyimpan koneksi SSRS: {ex.Message}" });
            }
        }

        [HttpDelete("connections/{id:int}")]
        public async Task<IActionResult> DeleteSavedConnection(int id)
        {
            try
            {
                var deleted = await _ssrsService.DeleteSavedSsrsConnectionAsync(id);
                if (deleted)
                {
                    return Ok(new { Success = true, Message = "Koneksi SSRS berhasil dihapus" });
                }
                return NotFound(new { Success = false, Message = "Koneksi SSRS tidak ditemukan" });
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = $"Gagal menghapus koneksi SSRS: {ex.Message}" });
            }
        }

        [HttpPost("connect")]
        public async Task<IActionResult> Connect([FromBody] SsrsBrowseRequestDto req)
        {
            try
            {
                var success = await _ssrsService.ConnectAsync(req);
                return Ok(new { Success = true, Message = "Koneksi ke SSRS berhasil." });
            }
            catch (Exception ex)
            {
                return Ok(new { Success = false, Message = ex.Message });
            }
        }

        [HttpPost("browse")]
        public async Task<IActionResult> Browse([FromBody] SsrsBrowseRequestDto req)
        {
            try
            {
                var items = await _ssrsService.BrowseAsync(req);
                return Ok(new { Success = true, Items = items });
            }
            catch (Exception ex)
            {
                return Problem(ex.Message);
            }
        }

        [HttpPost("download")]
        public async Task<IActionResult> Download([FromBody] SsrsDownloadRequestDto req)
        {
            try
            {
                var (bytes, filename, extension) = await _ssrsService.DownloadAsync(req);
                return File(bytes, "application/xml", filename + extension);
            }
            catch (ArgumentException ex)
            {
                return BadRequest(ex.Message);
            }
            catch (Exception ex)
            {
                return Problem(ex.Message);
            }
        }

        [HttpPost("download-folder")]
        public async Task<IActionResult> DownloadFolder([FromBody] SsrsBrowseRequestDto req)
        {
            try
            {
                var bytes = await _ssrsService.DownloadFolderAsync(req);
                var folderName = req.Path.Trim('/').Split('/').LastOrDefault() ?? "Root";
                if (string.IsNullOrEmpty(folderName)) folderName = "Root";

                return File(bytes, "application/zip", $"{folderName}_SSRS_Backup.zip");
            }
            catch (ArgumentException ex)
            {
                return BadRequest(ex.Message);
            }
            catch (Exception ex)
            {
                return Problem($"Gagal mengunduh folder: {ex.Message}");
            }
        }

        [HttpPost("create-folder")]
        public async Task<IActionResult> CreateFolder([FromBody] SsrsCreateFolderRequestDto req)
        {
            if (string.IsNullOrWhiteSpace(req.FolderName))
            {
                return BadRequest("Nama folder tidak boleh kosong.");
            }

            try
            {
                await _ssrsService.CreateFolderAsync(req);
                return Ok(new { Success = true, Message = $"Folder '{req.FolderName.Trim()}' berhasil dibuat." });
            }
            catch (Exception ex)
            {
                return Problem(ex.Message);
            }
        }

        [HttpPost("delete-item")]
        public async Task<IActionResult> DeleteItem([FromBody] SsrsDeleteItemRequestDto req)
        {
            if (string.IsNullOrWhiteSpace(req.Path) || req.Path == "/")
            {
                return BadRequest("Path tidak valid atau tidak diizinkan untuk dihapus.");
            }

            try
            {
                await _ssrsService.DeleteItemAsync(req);
                return Ok(new { Success = true, Message = "Item berhasil dihapus." });
            }
            catch (Exception ex)
            {
                return Problem(ex.Message);
            }
        }

        [HttpPost("get-datasource")]
        public async Task<IActionResult> GetDataSource([FromBody] SsrsDownloadRequestDto req)
        {
            try
            {
                var result = await _ssrsService.GetDataSourceAsync(req);
                return Ok(new
                {
                    Success = true,
                    Extension = result.Extension,
                    ConnectString = result.ConnectString,
                    CredentialRetrieval = result.CredentialRetrieval,
                    WindowsCredentials = result.WindowsCredentials,
                    UserName = result.UserName
                });
            }
            catch (ArgumentException ex)
            {
                return BadRequest(ex.Message);
            }
            catch (Exception ex)
            {
                return Problem(ex.Message);
            }
        }

        [HttpPost("set-datasource")]
        public async Task<IActionResult> SetDataSource([FromBody] SsrsSetDataSourceRequestDto req)
        {
            try
            {
                await _ssrsService.SetDataSourceAsync(req);
                return Ok(new { Success = true, Message = "Koneksi Data Source berhasil disimpan." });
            }
            catch (Exception ex)
            {
                return Problem(ex.Message);
            }
        }

        [HttpPost("test-datasource-connection")]
        public async Task<IActionResult> TestDataSourceConnection([FromBody] SsrsTestDataSourceConnectionRequestDto req)
        {
            try
            {
                await _ssrsService.TestDataSourceConnectionAsync(req);
                return Ok(new { Success = true, Message = "Koneksi berhasil terhubung!" });
            }
            catch (ArgumentException ex)
            {
                return Ok(new { Success = false, Message = ex.Message });
            }
            catch (Exception ex)
            {
                return Ok(new { Success = false, Message = $"Gagal terhubung: {ex.Message}" });
            }
        }

        [HttpPost("upload")]
        public async Task<IActionResult> Upload(CancellationToken cancellationToken)
        {
            try
            {
                var request = HttpContext.Request;
                if (!request.HasFormContentType)
                {
                    return BadRequest("Request harus berupa Form Data.");
                }

                var form = await request.ReadFormAsync(cancellationToken);
                var url = form["url"].ToString();
                var username = form["username"].ToString();
                var password = form["password"].ToString();
                var domain = form["domain"].ToString();
                var parentPath = form["parentPath"].ToString();

                if (string.IsNullOrEmpty(url))
                {
                    return BadRequest("URL Server SSRS tidak boleh kosong.");
                }

                var file = form.Files.FirstOrDefault();
                if (file == null || file.Length == 0)
                {
                    return BadRequest("Tidak ada file yang diunggah.");
                }

                using var stream = file.OpenReadStream();
                var result = await _ssrsService.UploadFileAsync(url, username, password, domain, parentPath, file.FileName, stream);
                return Ok(result);
            }
            catch (Exception ex)
            {
                return Problem($"Gagal mengunggah berkas: {ex.Message}");
            }
        }
    }
}
