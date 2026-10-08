export const metadata = { title: 'Payment link' };

export default function UnknownCheckoutPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="bg-card max-w-md rounded-2xl border p-8 text-center shadow-sm">
        <h1 className="text-xl font-semibold">This payment link isn’t valid</h1>
        <p className="text-muted-foreground mt-2 text-sm">Go back to the merchant’s website to start the payment again.</p>
      </div>
    </div>
  );
}
