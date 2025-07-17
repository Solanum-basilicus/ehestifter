-- Table: EnrichmentResults

IF NOT EXISTS (
    SELECT 1 FROM sys.objects 
    WHERE object_id = OBJECT_ID(N'[dbo].[EnrichmentResults]') AND type = 'U'
)
BEGIN
    CREATE TABLE EnrichmentResults (
        Id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),

        JobOfferingId UNIQUEIDENTIFIER NOT NULL 
            FOREIGN KEY REFERENCES JobOfferings(Id),

        EnricherName NVARCHAR(100) NOT NULL,         -- e.g., "CVMatcher", "Glassdoor"

        ResultJson NVARCHAR(MAX) NULL,               -- Raw output or structured LLM-compatible format
        Status NVARCHAR(20) NOT NULL,                -- "success", "failed", "skipped"
        ExecutedAt DATETIME2 DEFAULT SYSDATETIME(),

        CONSTRAINT UX_Enrichment_Uniqueness 
            UNIQUE (JobOfferingId, EnricherName, ExecutedAt)
    );
END

-- Index for fast lookup of latest enrichment result
IF NOT EXISTS (
    SELECT 1 
    FROM sys.indexes 
    WHERE name = 'IX_Enrichment_LatestPerEnricher' AND object_id = OBJECT_ID('EnrichmentResults')
)
BEGIN
    CREATE NONCLUSTERED INDEX IX_Enrichment_LatestPerEnricher
        ON EnrichmentResults (JobOfferingId, EnricherName, ExecutedAt DESC);
END