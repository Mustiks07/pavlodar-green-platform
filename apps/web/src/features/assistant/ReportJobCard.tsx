import { JobStatus, Notice, Skeleton } from '@pg/ui';
import { ApiErrorView } from '../../shell/ApiErrorView';
import { ArtifactRow } from '../exports/ExportPanel';
import { useJob } from '../jobs/useJob';

/** Durable server-created PDF requested from chat; a reload resumes from the stored job id. */
export function ReportJobCard({ jobId }: { jobId: string }) {
  const job = useJob(jobId);

  if (job.isPending) return <Skeleton lines={2} />;
  if (job.isError) return <ApiErrorView compact error={job.error} onRetry={() => void job.refetch()} />;

  const artifactId = job.data.state === 'succeeded' ? job.data.result_ref_id : null;
  return (
    <section className="asst-report" aria-label="PDF-отчёт по проекту" data-report-job-id={jobId}>
      {artifactId ? (
        <ArtifactRow id={artifactId} format="pdf" onGone={() => void job.refetch()} />
      ) : (
        <>
          <p className="asst-report__title"><strong>PDF-отчёт по текущему проекту</strong></p>
          <JobStatus job={job.data} />
          {job.data.state === 'failed' ? (
            <Notice tone="negative" title="Не удалось сформировать отчёт">
              Повторите просьбу в чате. Текущая версия проекта и расчёт не изменены.
            </Notice>
          ) : null}
        </>
      )}
    </section>
  );
}
