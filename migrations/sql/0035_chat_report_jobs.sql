ALTER TABLE chat_messages
ADD COLUMN report_job_id UUID REFERENCES jobs(id);

ALTER TABLE chat_messages
ADD CONSTRAINT chat_messages_report_job_id_key UNIQUE (report_job_id);
