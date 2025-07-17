-- Table: SystemConfig

IF NOT EXISTS (
    SELECT 1 FROM sys.objects 
    WHERE object_id = OBJECT_ID(N'[dbo].[SystemConfig]') AND type = 'U'
)
BEGIN
    CREATE TABLE SystemConfig (
        [Key] NVARCHAR(100) PRIMARY KEY,      -- e.g., 'MinScoreForNotification'
        [Value] NVARCHAR(MAX) NOT NULL,       -- e.g., '8', or 'true', or JSON string
        Description NVARCHAR(500) NULL,       -- Optional: explain what this setting does
        UpdatedAt DATETIME2 DEFAULT SYSDATETIME()
    );
END