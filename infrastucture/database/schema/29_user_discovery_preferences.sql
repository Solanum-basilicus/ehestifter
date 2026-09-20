-- 29_user_discovery_preferences.sql
-- Store one normalized discovery-preference document for each user.

SET XACT_ABORT ON;
BEGIN TRANSACTION;

IF OBJECT_ID(N'dbo.Users', N'U') IS NULL
BEGIN
    RAISERROR('dbo.Users does not exist.', 16, 1);
    ROLLBACK TRANSACTION;
    RETURN;
END;

IF OBJECT_ID(N'dbo.UserDiscoveryPreferences', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.UserDiscoveryPreferences (
        UserId UNIQUEIDENTIFIER NOT NULL
            CONSTRAINT PK_UserDiscoveryPreferences PRIMARY KEY,
        SchemaVersion INT NOT NULL,
        PreferencesJson NVARCHAR(MAX) NOT NULL,
        LastUpdated DATETIME2(3) NOT NULL
            CONSTRAINT DF_UserDiscoveryPreferences_LastUpdated DEFAULT SYSUTCDATETIME(),

        CONSTRAINT FK_UserDiscoveryPreferences_Users
            FOREIGN KEY (UserId) REFERENCES dbo.Users(Id) ON DELETE CASCADE,
        CONSTRAINT CK_UserDiscoveryPreferences_SchemaVersion
            CHECK (SchemaVersion >= 1),
        CONSTRAINT CK_UserDiscoveryPreferences_Json
            CHECK (ISJSON(PreferencesJson) = 1)
    );
END;

COMMIT TRANSACTION;
GO
