IF OBJECT_ID(N'dbo.AnalyticsDispatch', N'U') IS NULL
AND OBJECT_ID(N'dbo.AnalyticsEvents', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.AnalyticsEvents (
        EventId uniqueidentifier NOT NULL
            CONSTRAINT PK_AnalyticsEvents PRIMARY KEY,

        OccurredAtUtc datetime2(3) NOT NULL,

        ReceivedAtUtc datetime2(3) NOT NULL
            CONSTRAINT DF_AnalyticsEvents_ReceivedAtUtc DEFAULT SYSUTCDATETIME(),

        SourceDomain nvarchar(40) NOT NULL,
        SourceSurface nvarchar(40) NOT NULL,
        UserId uniqueidentifier NULL,
        DistinctId nvarchar(128) NULL,
        EventName nvarchar(80) NOT NULL,
        SubjectType nvarchar(40) NULL,
        SubjectId nvarchar(80) NULL,
        CorrelationId nvarchar(100) NULL,
        ProducerEventId nvarchar(120) NULL,
        SchemaVersion int NOT NULL,
        PropertiesJson nvarchar(max) NOT NULL
    );

    CREATE INDEX IX_AnalyticsEvents_OccurredAtUtc
        ON dbo.AnalyticsEvents (OccurredAtUtc);

    CREATE INDEX IX_AnalyticsEvents_UserId_OccurredAtUtc
        ON dbo.AnalyticsEvents (UserId, OccurredAtUtc);

    CREATE UNIQUE INDEX UX_AnalyticsEvents_SourceDomain_ProducerEventId
        ON dbo.AnalyticsEvents (SourceDomain, ProducerEventId)
        WHERE ProducerEventId IS NOT NULL;

    CREATE INDEX IX_AnalyticsEvents_EventName_OccurredAtUtc
        ON dbo.AnalyticsEvents (EventName, OccurredAtUtc);

    CREATE TABLE dbo.AnalyticsDispatch (
        DispatchId uniqueidentifier NOT NULL
            CONSTRAINT PK_AnalyticsDispatch PRIMARY KEY,

        EventId uniqueidentifier NOT NULL,
        Sink nvarchar(40) NOT NULL,
        Status nvarchar(20) NOT NULL,

        AttemptCount int NOT NULL
            CONSTRAINT DF_AnalyticsDispatch_AttemptCount DEFAULT 0,

        NextAttemptAtUtc datetime2(3) NOT NULL,
        LastAttemptAtUtc datetime2(3) NULL,
        SentAtUtc datetime2(3) NULL,
        LastErrorCode nvarchar(80) NULL,
        LastErrorJson nvarchar(max) NULL,

        CONSTRAINT FK_AnalyticsDispatch_AnalyticsEvents
            FOREIGN KEY (EventId) REFERENCES dbo.AnalyticsEvents(EventId),

        CONSTRAINT CK_AnalyticsDispatch_Sink
            CHECK (Sink IN ('mixpanel')),

        CONSTRAINT CK_AnalyticsDispatch_Status
            CHECK (Status IN ('pending', 'sending', 'sent', 'retry', 'dead', 'disabled'))
    );

    CREATE UNIQUE INDEX UX_AnalyticsDispatch_Sink_EventId
        ON dbo.AnalyticsDispatch (Sink, EventId);

    CREATE INDEX IX_AnalyticsDispatch_Sink_Status_NextAttemptAtUtc
        ON dbo.AnalyticsDispatch (Sink, Status, NextAttemptAtUtc);

    CREATE INDEX IX_AnalyticsDispatch_Status_LastAttemptAtUtc
        ON dbo.AnalyticsDispatch (Status, LastAttemptAtUtc);
END;
