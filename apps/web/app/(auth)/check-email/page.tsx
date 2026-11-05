export default async function CheckEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string }>;
}) {
  const { email } = await searchParams;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Check your email</h1>
      <p>
        We sent a verification link{email ? ` to ${email}` : ''}. Open it to finish signing up. The
        link expires in one hour.
      </p>
    </div>
  );
}
