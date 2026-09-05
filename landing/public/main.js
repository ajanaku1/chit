function initializeMotion() {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const reveals = [...document.querySelectorAll("[data-reveal]")];

  if (reduceMotion || !("IntersectionObserver" in window)) {
    reveals.forEach(function showReveal(element) {
      element.classList.add("is-visible");
    });
    return;
  }

  document.documentElement.classList.add("motion-ready");

  const observer = new IntersectionObserver(function revealEntries(entries) {
    entries.forEach(function revealEntry(entry) {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    });
  }, { rootMargin: "0px 0px -12%", threshold: 0.1 });

  reveals.forEach(function observeReveal(element) {
    observer.observe(element);
  });
}

function initializeContractCopy() {
  const button = document.getElementById("copy-contract-address");
  const contractAddress = document.getElementById("contract-address");
  const status = document.getElementById("copy-contract-status");

  if (!button || !contractAddress || !status) return;

  button.addEventListener("click", async function copyContractAddress() {
    try {
      await navigator.clipboard.writeText(contractAddress.textContent ?? "");
      button.textContent = "Copied";
      status.textContent = "Contract address copied.";
      status.classList.remove("error");
    } catch {
      button.textContent = "Copy";
      status.textContent = "Copy failed. Try again.";
      status.classList.add("error");
    }
  });
}

initializeMotion();
initializeContractCopy();
