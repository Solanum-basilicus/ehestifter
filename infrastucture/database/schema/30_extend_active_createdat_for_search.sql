-- Stage 1: add search columns to the active CreatedAt index.
-- Run this file in the Jobs database during low traffic.
-- Stop if the existing index does not match the known definition.
-- Required session options for a filtered index.
SET ANSI_NULLS ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET ARITHABORT ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET QUOTED_IDENTIFIER ON;
SET NUMERIC_ROUNDABORT OFF;
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @table_id int = OBJECT_ID(N'dbo.JobOfferings', N'U');
DECLARE @index_id int;
DECLARE @keys nvarchar(4000);
DECLARE @includes nvarchar(4000);

IF @table_id IS NULL
    THROW 51030, 'dbo.JobOfferings does not exist.', 1;

SELECT @index_id = i.index_id
FROM sys.indexes AS i
WHERE i.object_id = @table_id
  AND i.name = N'IX_JobOfferings_Active_CreatedAt'
  AND i.type = 2
  AND i.is_unique = 0
  AND i.is_disabled = 0
  AND i.has_filter = 1
  AND REPLACE(LOWER(i.filter_definition), N' ', N'') = N'([isdeleted]=(0))';

IF @index_id IS NULL
    THROW 51031, 'The active CreatedAt index is missing or has a different filter or type.', 1;

SELECT @keys = STRING_AGG(
    CONCAT(ic.key_ordinal, N':', c.name, N':', ic.is_descending_key), N','
) WITHIN GROUP (ORDER BY ic.key_ordinal)
FROM sys.index_columns AS ic
JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE ic.object_id = @table_id AND ic.index_id = @index_id AND ic.key_ordinal > 0;

SELECT @includes = STRING_AGG(c.name, N',') WITHIN GROUP (ORDER BY c.name)
FROM sys.index_columns AS ic
JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE ic.object_id = @table_id AND ic.index_id = @index_id AND ic.is_included_column = 1;

IF COALESCE(@keys, N'') <> N'1:CreatedAt:1,2:Id:0'
    THROW 51032, 'The active CreatedAt index has unexpected keys.', 1;

IF @includes = N'CreatedByUserId,HiringCompanyName,PostingCompanyName,Title,UpdatedAt'
BEGIN
    PRINT 'The search columns are already in the active CreatedAt index. No change made.';
END
ELSE IF @includes = N'CreatedByUserId,UpdatedAt'
BEGIN
    -- Replace this index only. Keep its name, keys, and filter.
    CREATE NONCLUSTERED INDEX IX_JobOfferings_Active_CreatedAt
        ON dbo.JobOfferings (CreatedAt DESC, Id)
        INCLUDE (UpdatedAt, CreatedByUserId, Title, HiringCompanyName, PostingCompanyName)
        WHERE IsDeleted = 0
        WITH (DROP_EXISTING = ON);

    PRINT 'The active CreatedAt index now includes search columns.';
END
ELSE
    THROW 51033, 'The active CreatedAt index has unexpected included columns.', 1;
