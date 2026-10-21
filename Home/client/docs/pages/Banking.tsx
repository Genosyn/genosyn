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
            invoices a deposit paid, or what a payment was for, and Genosyn keeps the books. Find it
            under <Code>Finance → Banking</Code>.
          </>
        }
      />

      <H2 id="how-it-works">How it works</H2>
      <OL>
        <LI>
          <Strong>Add your accounts</Strong> — a bank account you upload statements for, a Brex
          business account or card, a Wise balance, or Stripe payouts.
        </LI>
        <LI>
          <Strong>Bring transactions in</Strong> — import a CSV, or click <Code>Update now</Code>{" "}
          on a connected account.
        </LI>
        <LI>
          <Strong>Work through To review</Strong> — open each transaction and choose what it was:
          the payment of one or more invoices, something already in your books, or a category. To
          file many the same way, tick them and <DocLink to="#bulk">categorize them at once</DocLink>.
        </LI>
      </OL>
      <P>
        The accounts sit across the top of the page, each with how many of its transactions are
        waiting. Click one to see only its transactions, or <Code>All accounts</Code> to see
        every account together. The list has three tabs: <Code>To review</Code> (nothing explains
        the transaction yet, or a card purchase&apos;s category is waiting for a look),{" "}
        <Code>Done</Code>, and <Code>All</Code>. The search box finds a transaction by its
        description, amount, account, invoice, or category. The Finance <Code>Overview</Code>{" "}
        shows how many transactions are waiting, with a link here.
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
            def: "Brex corporate card purchases, refunds, and card bill payments. Each purchase is filed under the card's default category as it arrives, and waits in To review for you to keep that category or pick another.",
          },
          {
            term: "Wise balance",
            def: "One balance on a Wise business account, in your home currency. Pick the Wise Connection and the balance, and its transactions — fees included — come in when you click Update now.",
          },
          {
            term: "Stripe payouts",
            def: "The payouts Stripe sends to your bank, from a Stripe Connection.",
          },
        ]}
      />
      <P>
        Brex, Wise, and Stripe accounts need a Connection first: add one under{" "}
        <DocLink to="/docs/integrations">Finance → Integrations</DocLink>. A Brex card needs a
        token that can read card transactions (<Code>transactions.card.readonly</Code>).
      </P>
      <P>
        A Wise account lists every balance the token can read, but only balances in your home
        currency can be added — the others are greyed out — and each balance can be added once.
        Wise releases statements to its API tokens only for business accounts based in the US,
        Canada, Australia, New Zealand, Singapore, and Malaysia, so for any other account{" "}
        <Code>Add account</Code> explains that instead of adding it (see{" "}
        <DocLink to="/docs/integrations#wise">Wise balances</DocLink>).
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
        brings in everything new; the first update walks the whole history. A Wise balance also
        looks again at the 30 days before its last update, because Wise dates each transaction by
        when it was created, which can be days before it reached the balance; nothing comes in
        twice. A deposit for the same amount as a payment already recorded on an invoice, within
        three days of it, is matched to that payment on the way in — when it is the only payment
        that fits.
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

      <H3 id="mark-paid">It paid invoices</H3>
      <P>
        For money coming in, Genosyn lists the invoices still waiting for payment, best guess
        first: one whose amount due is exactly the deposit, or whose customer or number the
        bank&apos;s description mentions, comes to the top, tagged <Code>Same amount</Code> or{" "}
        <Code>Named in the description</Code>. <Code>Show all open invoices</Code> lists the rest
        with a search box.
      </P>
      <P>
        Tick the invoices the deposit paid — one, or several a customer settled with one transfer.
        A ticked invoice takes what is still due on it, or what is left of the deposit when that is
        less, and you can change the amount to pay part of an invoice. Below the list, the ticked
        amounts add up against the deposit; once they match it exactly, <Code>Mark paid</Code>{" "}
        records a payment on every ticked invoice and links them all to the deposit, in one step.
        When exactly one invoice is both the same amount and named in the description, it starts
        ticked.
      </P>
      <P>
        When several of one customer&apos;s invoices add up to exactly the deposit, Genosyn says so
        above the list, and <Code>Tick these</Code> ticks them. Customers usually clear their
        oldest invoices first, so those are suggested first.
      </P>
      <P>
        Each payment is a <Code>Bank transfer</Code> dated the day the money arrived, posted to the
        bank account it arrived in, with a note on the invoice saying it was recorded from Banking.
        An invoice it settles turns <Code>Paid</Code>, and owners and admins get the usual{" "}
        <DocLink to="/docs/finance#invoices-paid-confirmation">paid confirmation</DocLink>. It is
        all or nothing: if one payment can&apos;t be recorded, none are.
      </P>
      <UL>
        <LI>
          No invoice can take more than what is still due on it. If the customer paid more than the
          invoices owe, record the payment on the invoice with{" "}
          <Code>Record the excess as an on-account customer credit</Code> ticked (see{" "}
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
      <P>
        Banking is the only place a bank transaction&apos;s category changes: to file one
        somewhere else, <DocLink to="#undo">undo</DocLink> it and categorize it again.{" "}
        <DocLink to="/docs/finance#transaction-review">Entry review</DocLink> shows its entries
        without a category picker and approves them as they are. A transaction Entry review moved
        to another category in the past shows the category it is in now, and Undo takes it out of
        that one.
      </P>

      <H3 id="undo">Undo</H3>
      <P>
        Open a transaction in <Code>Done</Code> to see what explains it, and click{" "}
        <Code>Undo</Code> to send it back to <Code>To review</Code>. Undo takes back exactly what
        was done, and says so before it does:
      </P>
      <UL>
        <LI>
          Every payment recorded with <Code>Mark paid</Code> comes off its invoice, which shows
          that amount due again.
        </LI>
        <LI>
          A category is reversed with an opposite entry, from the category the transaction is
          filed under now, so the books follow the list.
        </LI>
        <LI>
          A match only unlinks: the payment or entry it was matched to stays where it is.
        </LI>
      </UL>
      <P>
        Deleting a payment from an invoice sends the bank transaction it came in back to{" "}
        <Code>To review</Code> too, so a transaction never claims a payment that is gone. When the
        deposit paid several invoices, the others stay paid from it and the transaction shows{" "}
        <Code>Part paid</Code>: open it to tick what the rest paid, or <Code>Undo</Code> to take
        the other payments off too and start over. A category in a{" "}
        <DocLink to="/docs/finance#ledger">closed accounting period</DocLink> can&apos;t be
        undone until the period is reopened.
      </P>

      <H2 id="cards">Card purchases</H2>
      <P>
        A card&apos;s purchases are in your books as soon as they arrive, under the card&apos;s
        default category, and wait in <Code>To review</Code> for someone to check that category.
        A waiting purchase shows its category tinted amber, with a check beside it:
      </P>
      <UL>
        <LI>
          If the category is right, click the check. The purchase moves to <Code>Done</Code> and
          nothing in your books changes.
        </LI>
        <LI>
          If it isn&apos;t, pick another category right in the list. Genosyn posts a separate
          reclassification entry, so the original stays in the audit trail, and the purchase
          moves to <Code>Done</Code>.
        </LI>
      </UL>
      <P>
        A purchase in <Code>Done</Code> can still move to another category the same way, and{" "}
        <DocLink to="#bulk">Send to review</DocLink> puts it back in <Code>To review</Code> with
        its category as it is. Purchases that arrived before card purchases waited for review
        start in <Code>Done</Code>: to go through them, open the card&apos;s <Code>Done</Code>{" "}
        tab, tick them, and send them back to review. A purchase Genosyn couldn&apos;t add to the
        books waits too — the row says why, and <Code>Retry</Code> tries again. Refunds come back
        under the same category, and card bill payments move what you owe on the card against the
        bank account that paid it. A bill payment has no category, so it never waits: match it on
        the bank account&apos;s side rather than categorizing it, or it would count twice.
      </P>
      <P>
        Banking is the only place a card purchase&apos;s category changes. Each change moves the
        purchase from the category it is filed under now, so the category in the list is always
        the one in your books, however many times you change it.{" "}
        <DocLink to="/docs/finance#transaction-review">Entry review</DocLink> shows a card
        purchase&apos;s entries without a category picker and approves them as they are.
      </P>

      <H3 id="fix-card-categories">Purchases Entry review changed</H3>
      <P>
        Before Banking was the only place, Entry review could change a card purchase&apos;s
        category without telling Banking. Genosyn puts right what that left behind:
      </P>
      <UL>
        <LI>
          If your books hold a purchase under one category and Banking showed another, Banking
          now shows the one in your books. Genosyn does this by itself when it starts, and posts
          nothing.
        </LI>
        <LI>
          If your books file a purchase under more than one category, a notice above the list
          says how many. <Code>Review</Code> shows each one: the category Banking shows, where
          your books have it, and the one entry <Code>Fix</Code> posts, dated today, so that only
          Banking&apos;s category holds it. The entry only moves an amount between expense
          categories, so your total expenses stay the same, and a closed period is never touched.
        </LI>
      </UL>
      <P>
        <Code>Fix</Code> needs Full finance access and is recorded in the audit log. If you
        already corrected a purchase with a journal entry, leave it: fixing it here as well would
        correct it twice. A purchase whose entries don&apos;t add up says why and has no{" "}
        <Code>Fix</Code>; correct it with a journal entry.
      </P>

      <H2 id="bulk">Work on many at once</H2>
      <P>
        With Full finance access every row has a tick box. Tick one, shift-click another to tick
        everything between them, or tick the box above the list to take every transaction in
        view. Search first to narrow it: <Code>Claude</Code>, then the box above the list, ticks
        every Claude purchase. A bar opens at the bottom of the page with what the ticked
        transactions can take:
      </P>
      <KeyList
        rows={[
          {
            term: "Categorize",
            def: (
              <>
                Pick one category for all of them, then click <Code>Categorize</Code>. A bank
                transaction in <Code>To review</Code> is categorized as its own{" "}
                <Code>Categorize</Code> would. A card purchase moves to the category with a
                reclassification, whether it was waiting or done, and moves to <Code>Done</Code>.
                A card purchase takes only an expense category, so card purchases alone are
                offered only expenses. A done bank transaction takes a new category only once it
                is back in review.
              </>
            ),
          },
          {
            term: "Mark reviewed",
            def: "Card purchases waiting for review keep their categories and move to Done.",
          },
          {
            term: "Send to review",
            def: (
              <>
                Puts done transactions back in <Code>To review</Code>. A card purchase keeps its
                category. A bank transaction is undone as its own <DocLink to="#undo">Undo</DocLink>{" "}
                would — a category reversed with an opposite entry, a match unlinked — and Genosyn
                says what it will undo before it does. A deposit that paid invoices is left out:
                open it and use <Code>Undo</Code>, which says which payments come off which
                invoices.
              </>
            ),
          },
        ]}
      />
      <P>
        Each transaction is handled on its own, under the same rules as its row. If some
        can&apos;t take the action — a date in a closed period, say — the rest still go through,
        and Genosyn lists why the others didn&apos;t; they stay ticked. A card bill payment
        can&apos;t be ticked, and neither can a deposit that paid invoices. <Code>Esc</Code> clears
        the selection. Every bulk change is recorded in the audit log.
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
        <Strong>Full</Strong> access a Member adds and removes accounts, imports, updates,
        explains or undoes transactions, ticks them to change many at once, and fixes card
        categories. With{" "}
        <Strong>Read-only</Strong> access they see every account and transaction, and what
        explains it, without any of those controls.
      </P>
    </>
  );
}
