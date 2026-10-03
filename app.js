const { createClient } = supabase;

const db = createClient(
  window.SUPABASE_URL,
  window.SUPABASE_PUBLISHABLE_KEY,
  {
    auth: {
      persistSession: false
    }
  }
);


/* =========================================================
   HJÄLPFUNKTIONER
========================================================= */

function $(id) {
  return document.getElementById(id);
}


function esc(v) {
  return String(v ?? "").replace(
    /[&<>"']/g,
    c => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[c])
  );
}


function msg(el, text, type = "") {

  if (!el) return;

  el.className = "msg " + type;
  el.textContent = text;
  el.classList.remove("hidden");

}


/* =========================================================
   KUND – INLOGGNING
========================================================= */

function saveMember(member) {

  localStorage.setItem(
    "library_member",
    JSON.stringify(member)
  );

}


function getMember() {

  try {

    return JSON.parse(
      localStorage.getItem("library_member")
    );

  } catch {

    return null;

  }

}


function logoutMember() {

  localStorage.removeItem("library_member");

  location.href = "kund.html";

}


async function memberLogin(card, personnummer) {

  const { data, error } =
    await db.rpc(
      "library_member_login",
      {
        p_card: card,
        p_personnummer: personnummer
      }
    );

  if (error) throw error;

  if (!data?.length) {

    throw new Error(
      "Fel lånekortsnummer eller personnummer."
    );

  }

  saveMember(data[0]);

  return data[0];

}


/* =========================================================
   KUND – HÄMTA MINA LÅN
========================================================= */

async function getMyLoans(memberId) {

  const { data, error } =
    await db.rpc(
      "get_my_loans",
      {
        p_member_id: memberId
      }
    );

  if (error) throw error;

  return (data || []).map(l => ({

    id: l.id,

    barcode: l.barcode,

    borrowed_at: l.borrowed_at,

    due_date: l.due_date,

    returned_at: l.returned_at,

    renew_count: l.renew_count,

    books: {
      title: l.title,
      author_initials: l.author_initials
    }

  }));

}


/* =========================================================
   KUND – LÅNA OM
========================================================= */

async function renewLoan(loanId, memberId) {

  const { data, error } =
    await db.rpc(
      "renew_book",
      {
        p_loan_id: loanId,
        p_member_id: memberId
      }
    );

  if (error) throw error;

  return data;

}


/* =========================================================
   BÖCKER
========================================================= */

async function findBook(barcode) {

  const { data, error } =
    await db
      .from("books")
      .select(
        "id,barcode,title,author_initials,shelf,aisle,available"
      )
      .eq("barcode", barcode)
      .maybeSingle();

  if (error) throw error;

  return data;

}


/* =========================================================
   LÅNA BÖCKER
========================================================= */

async function borrowBooks(memberId, barcodes) {

  const { data, error } =
    await db.rpc(
      "borrow_books",
      {
        p_member_id: memberId,
        p_barcodes: barcodes
      }
    );

  if (error) throw error;

  return data;

}


/* =========================================================
   LÄMNA TILLBAKA BÖCKER
========================================================= */

async function returnBooks(memberId, barcodes) {

  const { data, error } =
    await db.rpc(
      "return_books",
      {
        p_member_id: memberId,
        p_barcodes: barcodes
      }
    );

  if (error) throw error;

  return data;

}
