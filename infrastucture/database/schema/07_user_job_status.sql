-- Table: UserJobStatus

IF NOT EXISTS (
    SELECT 1 FROM sys.objects 
    WHERE object_id = OBJECT_ID(N'[dbo].[UserJobStatus]') AND type = 'U'
)
BEGIN
    CREATE TABLE UserJobStatus (
        Id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),

        JobOfferingId UNIQUEIDENTIFIER NOT NULL 
            FOREIGN KEY REFERENCES JobOfferings(Id),

        UserId UNIQUEIDENTIFIER NOT NULL 
            FOREIGN KEY REFERENCES Users(Id),

        Status NVARCHAR(100) NOT NULL,          -- e.g., 'applied', 'interviewed', 'rejected'
        Comment NVARCHAR(MAX) NULL,             -- Optional note from user

        LastUpdated DATETIME2 DEFAULT SYSDATETIME(),

        CONSTRAINT UX_UserJobStatus_Unique UNIQUE (JobOfferingId, UserId)
    );
END