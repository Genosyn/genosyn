import { Callout, Code, DocLink, H2, H3, KeyList, LI, OL, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function Banking() {
  return (
    <>
      <PageHeader
        eyebrow="Module"
        title="Banking"
        lead={
          <>
            Your bank accounts and cards, and every transaction on them, in one list. Say which
            invoice a deposit paid, or what a payment was for, and Genosyn keeps the books. Find it
            under <Code>Finance → Banking</Code>.
          </>
        }
      />

      <H2 id="how-it-works">How it works</H2>
      <OL>
        <LI>
          <Strong>Add your accounts</Strong> — a bank account you upload statements for, a Brex
          business account or card, or Stripe payouts.
        </LI>
        <LI>
          <Strong>Bring transactions in</Strong> — import a CSV, or click <Code>Update now</Code>{" "}
          on a connected account.
        </LI>
        <LI>
          <Strong>Work through To review</Strong> — open each transaction and choose what it was:
          the payment of an invoice, something already in your books, or a category.
        </LI>
      </OL>
      <P>
        The accounts sit across the top of the page, each with how many of its transactions are
        waiting. Click one to see only its transactions, or <Code>All accounts</Code> to see
        every account together. The list has three tabs: <Code>To review</Code> (nothing explains
        the transaction yet), <Code>Done</Code>, and <Code>All</Code>. The search box finds a
        transaction by its description, amount, account, invoice, or category. The Finance{" "}
        <Code>Overview</Code> shows how many bank transactions are waiting, with a link here.
      </P>

      <H2 id="add-account">Add an account</H2>
      <P>
        Click <Code>Add account</Code> and choose what kind it is:
      </P>
      <KeyList
        rows={[
          {
            term: "Bank account",
            def: (
              <>
                Any bank. Download your transactions as a CSV from the bank&apos;s website and
                import the file. Right after you add the account, Genosyn asks for the first one.
              </>
            ),
          },
          {
            term: "Brex business account",
            def: "A Brex cash account. Pick the Brex Connection and the account, and its transactions come in when you click Update now.",
          },
          {
            term: "Brex card",
            def: "Brex corporate card purchases, refunds, and card bill payments. Each purchase is filed under the card's default category as it arrives.",
          },
          {
            term: "Stripe payouts",
            def: "The payouts Stripe sends to your bank, from a Stripe Connection.",
          },
        ]}
      />
      <P>
        Brex and Stripe accounts need a Connection first: add one under{" "}
        <DocLink to="/docs/integrations">Finance → Integrations</DocLink>. A Brex card needs a
        token that can read card transactions (<Code>transactions.card.readonly</Code>).
      </P>
      <P>
        <Code>Advanced</Code> says where the account&apos;s money shows up in your books. A bank
        account posts to <Code>1100 Bank</Code> by default; a company with several bank accounts
        can give each its own asset account in the{" "}
        <DocLink to="/docs/finance#ledger">chart of accounts</DocLink>. A card keeps what you owe
        in <Code>2300 Corporate Card Payable</Code>, files purchases under{" "}
        <Code>6000 General &amp; Administrative</Code> until you change them, and is paid from{" "}
        <Code>1100 Bank</Code>.
      </P>

      <H3 id="import-update">Importing and updating</H3>
      <P>
        Pick an account to see its actions. A CSV bank account has <Code>Import CSV</Code>: the
        file needs a header row with at least a date and an amount column (common names such as{" "}
        <Code>Date</Code>, <Code>Amount</Code>, <Code>Description</Code> and{" "}
        <Code>Reference</Code> work). Rows already imported are skipped, so uploading an
        overlapping statement is safe. A connected account has <Code>Update now</Code>, which
        brings in everything new; the first update walks the whole history. A deposit for the same
        amount as a payment already recorded on an invoice, within three days of it, is matched to
        that payment on the way in — when it is the only payment that fits.
      </P>
      <P>
        <Code>Remove</Code> takes an account off Banking. A bank account&apos;s transactions go
        with it, but whatever they put in your books — invoice payments and categories — stays. A
        card can be removed only before its first update, because its purchases are part of your
        books from then on.
      </P>

      <H2 id="review">Explain a bank transaction</H2>
      <P>
        Click a transaction in <Code>To review</Code> to open it. It offers up to three answers,
        and you pick one.
      </P>

      <H3 id="mark-paid">It paid an invoice</H3>
      <P>
        For money coming in, Genosyn lists the invoices still waiting for payment, best guess
        first: one whose amount due is exactly the deposit, or whose customer or number the
        bank&apos;s description mentions, comes to the top, tagged <Code>Same amount</Code> or{" "}
        <Code>Named in the description</Code>. <Code>Show all open invoices</Code> lists the rest
        with a search box.
      </P>
      <P>
        <Code>Mark paid</Code> records the deposit as the invoice&apos;s payment and links the two,
        in one step. The payment is a <Code>Bank transfer</Code> dated the day the money arrived,
        posted to the bank account it arrived in, with a note on the invoice saying it was recorded
        from Banking. A deposit smaller than what is due pays part of the invoice. When it settles
        the invoice, the invoice turns <Code>Paid</Code> and owners and admins get the usual{" "}
        <DocLink to="/docs/finance#invoices-paid-confirmation">paid confirmation</DocLink>.
      </P>
      <UL>
        <LI>One deposit pays one invoice.</LI>
        <LI>
          A deposit bigger than what is due can&apos;t pay the invoice here. Record it on the
          invoice with <Code>Record the excess as an on-account customer credit</Code> ticked (see{" "}
          <DocLink to="/docs/finance#refunds-deposits">overpayments</DocLink>), then match the
          deposit to that payment.
        </LI>
        <LI>
          Bank transactions are in your home currency, so only home-currency invoices are offered.
          For an invoice in another currency, record the payment on the invoice, then match it.
        </LI>
      </UL>

      <H3 id="match">It&apos;s already in your books</H3>
      <P>
        <Code>Is it already in your books?</Code> lists what someone has already recorded for this
        money and not yet matched to another transaction: a payment on an invoice, a bill payment,
        a card bill payment, a refund, or a manual entry. Entries of exactly the same amount show
        first; <Code>Show more around this date</Code> lists the others. <Code>Match</Code> links
        the transaction to it without changing your books — the money is already there.
      </P>

      <H3 id="categorize">Give it a category</H3>
      <P>
        Everything else gets a category: bank fees, software, rent, interest, money the owners put
        in, a loan repayment. Choose one from the list — money in leads with income, money out
        with expenses, and the rest follow — and click <Code>Categorize</Code>. Genosyn posts the
        matching entry to your books: money in adds to the bank account and to the category, and
        money out takes it the other way. The categories are your{" "}
        <DocLink to="/docs/finance#ledger">chart of accounts</DocLink>; add one there if none fits.
      </P>

      <H3 id="undo">Undo</H3>
      <P>
        Open a transaction in <Code>Done</Code> to see what explains it, and click{" "}
        <Code>Undo</Code> to send it back to <Code>To review</Code>. Undo takes back exactly what
        was done, and says so before it does:
      </P>
      <UL>
        <LI>
          A payment recorded with <Code>Mark paid</Code> comes off its invoice, which shows that
          amount due again.
        </LI>
        <LI>A category is reversed with an opposite entry, so the books follow the list.</LI>
        <LI>
          A match only unlinks: the payment or entry it was matched to stays where it is.
        </LI>
      </UL>
      <P>
        Deleting a payment from an invoice sends the bank transaction it explained back to{" "}
        <Code>To review</Code> too, so a transaction never claims a payment that is gone. A
        category in a{" "}
        <DocLink to="/docs/finance#ledger">closed accounting period</DocLink> can&apos;t be
        undone until the period is reopened.
      </P>

      <H2 id="cards">Card purchases</H2>
      <P>
        A card&apos;s purchases are in your books as soon as they arrive, under the card&apos;s
        default category, so they wait in <Code>To review</Code> only if Genosyn couldn&apos;t add
        one — the row says why, and <Code>Retry</Code> tries again. To file a purchase somewhere
        else, change its category right in the list; Genosyn posts a separate reclassification
        entry, so the original stays in the audit trail. Refunds come back under the same
        category, and card bill payments move what you owe on the card against the bank account
        that paid it — match that payment on the bank account&apos;s side rather than categorizing
        it, or it would count twice.
      </P>

      <Callout kind="tip" title="Entry review">
        Everything Banking puts in your books also appears under{" "}
        <DocLink to="/docs/finance#transaction-review">Finance → Entry review</DocLink>, for a
        company that wants an owner or admin to sign off on each entry. Banking itself never waits
        on that sign-off.
      </Callout>

      <H2 id="access">Who can do what</H2>
      <P>
        Banking follows each Member&apos;s{" "}
        <DocLink to="/docs/finance#finance-access">Finance access</DocLink>. With{" "}
        <Strong>Full</Strong> access a Member adds and removes accounts, imports, updates, and
        explains or undoes transactions. With <Strong>Read-only</Strong> access they see every
        account and transaction, and what explains it, without any of those controls.
      </P>
    </>
  );
}
