export default async function CheckEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string }>;
}) {
  const { email } = await searchParams;
  return (
    <div className="stack">
      <h1>Check your email</h1>
      <p>
        We sent a verification link{email ? ` to ${email}` : ''}. Open it to finish signing up. The
        link expires in one hour.
      </p>
    </div>
  );
}
