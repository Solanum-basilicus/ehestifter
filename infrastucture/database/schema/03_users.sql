IF NOT EXISTS (
    SELECT 1 FROM sys.objects 
    WHERE object_id = OBJECT_ID(N'[dbo].[Users]') AND type = 'U'
)
BEGIN
    CREATE TABLE Users (
        Id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),

        -- Identity Provider Reference
        B2CObjectId NVARCHAR(100) NOT NULL UNIQUE,  -- From B2C 'sub' claim (GUID)

        -- Optional contact methods for notifications
        TelegramId NVARCHAR(100) NULL,
        Email NVARCHAR(256) NULL,                  -- Redundant but handy for system usage

        -- Role / Access Control
        Role NVARCHAR(50) DEFAULT 'user',          -- e.g., 'user', 'admin'

        -- System metadata
        Username NVARCHAR(100) NULL,               -- Optional display name
        CreatedAt DATETIME2 DEFAULT SYSDATETIME()
    );
END