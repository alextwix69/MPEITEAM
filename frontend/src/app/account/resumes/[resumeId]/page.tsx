import { ResumeEditor } from '../../../../components/resume-editor';

export default async function ResumePage({ params }: { params: Promise<{ resumeId: string }> }) {
  const { resumeId } = await params;
  return <ResumeEditor resumeId={resumeId} />;
}
