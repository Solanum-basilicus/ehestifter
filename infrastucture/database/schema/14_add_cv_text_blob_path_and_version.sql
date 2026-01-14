-- Adds CVTextBlobPath and CVVersionId to dbo.UserPreferences

IF COL_LENGTH('dbo.UserPreferences', 'CVTextBlobPath') IS NULL
BEGIN
    ALTER TABLE dbo.UserPreferences
        ADD CVTextBlobPath NVARCHAR(500) NULL;
END
GO

IF COL_LENGTH('dbo.UserPreferences', 'CVVersionId') IS NULL
BEGIN
    ALTER TABLE dbo.UserPreferences
        ADD CVVersionId NVARCHAR(64) NULL; -- sha256 hex = 64 chars
END
GO