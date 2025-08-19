-- 12_users_updated_for_telegram.sql

-- 1) Add new columns if missing
IF COL_LENGTH('dbo.Users', 'TelegramUserId') IS NULL
BEGIN
    ALTER TABLE dbo.Users ADD TelegramUserId BIGINT NULL;
END
GO

IF COL_LENGTH('dbo.Users', 'TelegramLinkedAt') IS NULL
BEGIN
    ALTER TABLE dbo.Users ADD TelegramLinkedAt DATETIME2 NULL;
END
GO

IF COL_LENGTH('dbo.Users', 'TelegramLinkCode') IS NULL
BEGIN
    ALTER TABLE dbo.Users ADD TelegramLinkCode NVARCHAR(16) NULL;
END
GO

-- 2) Add unique filtered indexes (idempotent)
-- IF YOU FAIL ON THAT SCRIPT, RUN THE 1) PART MANUALY AND THEN RERUN FULL SCRIPT. 
-- I dont want to bother teaching Azure DB how to interpret "GO" commands >_>
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes WHERE name = 'IX_Users_TelegramUserId' AND object_id = OBJECT_ID('dbo.Users')
)
BEGIN
    CREATE UNIQUE INDEX IX_Users_TelegramUserId
    ON dbo.Users (TelegramUserId)
    WHERE TelegramUserId IS NOT NULL;
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes WHERE name = 'IX_Users_TelegramLinkCode' AND object_id = OBJECT_ID('dbo.Users')
)
BEGIN
    CREATE UNIQUE INDEX IX_Users_TelegramLinkCode
    ON dbo.Users (TelegramLinkCode)
    WHERE TelegramLinkCode IS NOT NULL;
END
GO

-- 3) Best-effort data backfill from legacy TelegramId (NVARCHAR)
UPDATE u
SET TelegramUserId   = TRY_CAST(u.TelegramId AS BIGINT),
    TelegramLinkedAt = COALESCE(TelegramLinkedAt, SYSDATETIME())
FROM dbo.Users u
WHERE u.TelegramUserId IS NULL
  AND ISNUMERIC(u.TelegramId) = 1;
GO
