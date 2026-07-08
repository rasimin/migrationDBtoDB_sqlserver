using System;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;
using DbMigrator.Web.Models;
using DbMigrator.Web.Services;

namespace DbMigrator.Web.Controllers
{
    [ApiController]
    [Route("api/report-raider")]
    public class ReportRaiderController : ControllerBase
    {
        private readonly ReportRaiderService _service;

        public ReportRaiderController(ReportRaiderService service)
        {
            _service = service;
        }

        [HttpPost("connect")]
        public async Task<IActionResult> Connect([FromBody] ReportRaiderConnectionRequest request)
        {
            try
            {
                var connectionString = request?.ConnectionString ?? "";
                var count = await _service.TestConnectionAsync(connectionString);
                var root = await _service.GetRootAsync(connectionString);
                return Ok(new { Success = true, Message = "Koneksi ReportServer berhasil.", RowCount = count, Root = root });
            }
            catch (Exception ex)
            {
                return Ok(new { Success = false, Message = ex.Message });
            }
        }

        [HttpPost("root")]
        public async Task<IActionResult> Root([FromBody] ReportRaiderConnectionRequest request)
        {
            try
            {
                var root = await _service.GetRootAsync(request?.ConnectionString ?? "");
                return Ok(new { Success = true, Root = root });
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        [HttpPost("children")]
        public async Task<IActionResult> Children([FromBody] ReportRaiderChildrenRequest request)
        {
            try
            {
                var items = await _service.GetChildrenAsync(request?.ConnectionString ?? "", request?.ParentId ?? Guid.Empty);
                return Ok(new { Success = true, Items = items });
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        [HttpPost("download")]
        public async Task<IActionResult> Download([FromBody] ReportRaiderDownloadRequest request)
        {
            try
            {
                var file = await _service.DownloadAsync(request?.ConnectionString ?? "", request?.ItemId ?? Guid.Empty);
                return File(file.Content, file.ContentType, file.FileName);
            }
            catch (Exception ex)
            {
                return BadRequest(ex.Message);
            }
        }

        [HttpPost("download-zip")]
        public async Task<IActionResult> DownloadZip([FromBody] ReportRaiderZipRequest request)
        {
            try
            {
                var file = await _service.DownloadZipAsync(request?.ConnectionString ?? "", request?.ItemIds ?? new());
                return File(file.Content, file.ContentType, file.FileName);
            }
            catch (Exception ex)
            {
                return BadRequest(ex.Message);
            }
        }
    }
}
