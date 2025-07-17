
-- Table: CompatibilityScores

IF NOT EXISTS (
    SELECT 1 FROM sys.objects 
    WHERE object_id = OBJECT_ID(N'[dbo].[CompatibilityScores]') AND type = 'U'
)
BEGIN
    CREATE TABLE CompatibilityScores (
        Id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),

        JobOfferingId UNIQUEIDENTIFIER NOT NULL 
            FOREIGN KEY REFERENCES JobOfferings(Id),

        UserId UNIQUEIDENTIFIER NOT NULL 
            FOREIGN KEY REFERENCES Users(Id),

        Score INT NOT NULL,                       -- 0–10, 0 = not compatible
        Explanation NVARCHAR(MAX) NULL,           -- LLM-generated or heuristic notes
        CalculatedAt DATETIME2 DEFAULT SYSDATETIME(),

        CONSTRAINT UX_Compatibility_Job_User UNIQUE (JobOfferingId, UserId)
    );
END