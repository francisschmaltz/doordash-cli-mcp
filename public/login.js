const form = document.querySelector("#login-form");
const secret = document.querySelector("#admin-secret");
const error = document.querySelector("#login-error");
const submit = form.querySelector("button[type='submit']");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.hidden = true;
  submit.disabled = true;

  try {
    const response = await fetch("/api/admin/session", {
      method: "POST",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ secret: secret.value })
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(body?.error || "Admin login failed.");
    }

    secret.value = "";
    window.location.replace("/");
  } catch (loginError) {
    error.textContent = loginError.message;
    error.hidden = false;
    secret.select();
  } finally {
    submit.disabled = false;
  }
});
