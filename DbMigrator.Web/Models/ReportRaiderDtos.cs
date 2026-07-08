using System;
using System.Collections.Generic;

namespace DbMigrator.Web.Models
{
    public class ReportRaiderConnectionRequest
    {
        public string ConnectionString { get; set; } = "";
    }

    public class ReportRaiderChildrenRequest : ReportRaiderConnectionRequest
    {
        public Guid ParentId { get; set; }
    }

    public class ReportRaiderDownloadRequest : ReportRaiderConnectionRequest
    {
        public Guid ItemId { get; set; }
    }

    public class ReportRaiderZipRequest : ReportRaiderConnectionRequest
    {
        public List<Guid> ItemIds { get; set; } = new();
    }

    public class ReportRaiderCatalogItem
    {
        public Guid ItemID { get; set; }
        public string Path { get; set; } = "";
        public string Name { get; set; } = "";
        public Guid? ParentID { get; set; }
        public int Type { get; set; }
        public int? DataLength { get; set; }
        public string TypeName => Type switch
        {
            1 => "Folder",
            2 => "Report",
            5 => "Data Source",
            8 => "Data Set",
            _ => $"Type {Type}"
        };
        public string Extension => Type switch
        {
            2 => ".rdl",
            5 => ".rds",
            8 => ".rsd",
            _ => ".bin"
        };
        public string DataLengthText
        {
            get
            {
                if (!DataLength.HasValue || DataLength.Value <= 0) return "0 B";
                var len = (double)DataLength.Value;
                if (len < 1024) return $"{len:N0} B";
                if (len < 1024 * 1024) return $"{len / 1024:N1} KB";
                return $"{len / 1024 / 1024:N1} MB";
            }
        }
    }

    public class ReportRaiderDownloadFile
    {
        public string FileName { get; set; } = "";
        public string ContentType { get; set; } = "application/octet-stream";
        public byte[] Content { get; set; } = Array.Empty<byte>();
    }
}
