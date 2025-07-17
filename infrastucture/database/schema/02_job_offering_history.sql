IF NOT EXISTS (
    SELECT 1 FROM sys.objects 
    WHERE object_id = OBJECT_ID(N'[dbo].[JobOfferingHistory]') AND type = 'U'
)
BEGIN
    CREATE TABLE JobOfferingHistory (
        Id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
        JobOfferingId UNIQUEIDENTIFIER FOREIGN KEY REFERENCES JobOfferings(Id),
        Timestamp DATETIME2 DEFAULT SYSDATETIME(),
        ActorType NVARCHAR(50),           -- 'system' or 'user'
        ActorId UNIQUEIDENTIFIER NULL,    -- NULL for system, or FK to Users
        Action NVARCHAR(100),             -- e.g., 'created', 'enriched:CVMatch'
        Details NVARCHAR(MAX)
    );
END