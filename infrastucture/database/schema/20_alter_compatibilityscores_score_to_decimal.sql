SET XACT_ABORT ON;
BEGIN TRANSACTION;

-- Safety check: table must exist
IF OBJECT_ID(N'dbo.CompatibilityScores', N'U') IS NULL
BEGIN
    RAISERROR('dbo.CompatibilityScores does not exist.', 16, 1);
    ROLLBACK TRANSACTION;
    RETURN;
END;

-- Optional visibility before change
SELECT
    COLUMN_NAME,
    DATA_TYPE,
    NUMERIC_PRECISION,
    NUMERIC_SCALE,
    IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'dbo'
  AND TABLE_NAME = 'CompatibilityScores'
  AND COLUMN_NAME IN ('Score', 'CalculatedAt');

-- Change Score from INT to DECIMAL(4,1) if needed
IF EXISTS (
    SELECT 1
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'dbo'
      AND TABLE_NAME = 'CompatibilityScores'
      AND COLUMN_NAME = 'Score'
      AND (
            DATA_TYPE <> 'decimal'
            OR NUMERIC_PRECISION <> 4
            OR NUMERIC_SCALE <> 1
          )
)
BEGIN
    ALTER TABLE dbo.CompatibilityScores
    ALTER COLUMN Score DECIMAL(4,1) NOT NULL;
END;

-- Add a check constraint for allowed score range, if not already present
IF NOT EXISTS (
    SELECT 1
    FROM sys.check_constraints
    WHERE name = 'CK_CompatibilityScores_Score_Range'
      AND parent_object_id = OBJECT_ID(N'dbo.CompatibilityScores')
)
BEGIN
    ALTER TABLE dbo.CompatibilityScores
    ADD CONSTRAINT CK_CompatibilityScores_Score_Range
        CHECK (Score >= 0.0 AND Score <= 10.0);
END;

COMMIT TRANSACTION;