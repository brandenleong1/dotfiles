# Clean Code Style Guide

Code is read far more often than it's written. Write for the next reader: clear intent, little to hold in your head,
easy to change.

This guide is about structure, not formatting. Indentation, braces, line length, and include order belong to the
formatter (`.clang-format`, `.editorconfig`, or the project's linter).

**C++17 is the default standard** for the examples, and for new code unless a project picks another. Where a C++20
feature would make a point clearer, the example stays C++17 and a note names the newer alternative. The ideas carry
over to other languages.

**Use judgement.** When a rule would hurt a particular piece of code, break it and leave a one-line note saying why,
in the code or the PR. Hold new code, and the code you touch, to these rules; leave working code you aren't
changing alone.

**Consistency within a file beats this guide.** In an existing file, follow its conventions, naming included.

## 1. Functions

Most structure lives in functions, and most confusion starts in one that does too much.

### 1.1 One Job Each (Single Responsibility)

A function does one thing. If it has numbered steps, blank-line sections with headings, or a name with "and" in it
(`loadAndValidateAndSave`), split it.

- **Keep orchestration apart from detail.** The top-level function reads like a summary of the steps; each step is a
  call whose name says what it's for.
- **Pull out a function** when other code wants it too, when it deserves a test of its own, or when leaving it
  inline drags the caller into detail.
- **Leave it in place** when extracting it would mean passing half the caller's locals along.
- **Not every name needs a function.** A value computed once can be a well-named local.
- **Something indivisible is one operation**, even with two verbs in it. Looking up and changing a value under one
  lock is a single step: call it by what it achieves, `reserveIfAvailable`, not `checkAndReserve`.

```cpp
// Avoid: three jobs in one body, separated by comments
void fulfilOrder(const Order& order) {
    // reserve the stock
    // ... 30 lines ...
    // price it and build the invoice
    // ... 25 lines ...
    // email the customer
    // ... 20 lines ...
}

// Prefer: the body is the summary; each step can be tested alone
void fulfilOrder(const Order& order) {
    const Reservation reservation = reserveStock(order.lines());
    const Invoice invoice = buildInvoice(order, reservation);
    sendInvoice(invoice, order.customerEmail());
}
```

```cpp
// Avoid: the reader jumps to a one-caller helper to see a single comparison
static bool pastDue(const Invoice& invoice, Date today) { return invoice.dueDate() < today; }

for (const Invoice& invoice : invoices) {
    if (!pastDue(invoice, today)) continue;
    remind(invoice);
}

// Prefer: a well-named local, right where it matters
for (const Invoice& invoice : invoices) {
    const bool overdue = invoice.dueDate() < today;
    if (!overdue) continue;
    remind(invoice);
}
```

```cpp
// Fine: lookup and decrement must happen under one lock, so they are one named operation
bool Inventory::reserveIfAvailable(const Sku& sku, int quantity) {
    std::lock_guard lock(mutex_);   // C++17 deduces the mutex type
    auto onHand = onHand_.find(sku);
    if (onHand == onHand_.end() || onHand->second < quantity) return false;
    onHand->second -= quantity;
    return true;
}
```

### 1.2 One Level of Abstraction

Each function stays at one altitude. Don't mix the domain story ("register the customer, welcome them") with
mechanics (index arithmetic, bit masks, parsing, string building) in the same body: give the mechanics a name of
their own.

```cpp
// Avoid: trimming and lower-casing in the middle of the business steps
void registerCustomer(const SignupForm& form) {
    std::string email = form.email;
    email.erase(0, email.find_first_not_of(" \t"));
    email.erase(email.find_last_not_of(" \t") + 1);
    std::transform(email.begin(), email.end(), email.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    customers_.add(Customer{form.name, email});
    mailer_.sendWelcome(email);
}

// Prefer: one call that says what the trimming is for
void registerCustomer(const SignupForm& form) {
    const std::string email = normalizedEmail(form.email);
    customers_.add(Customer{form.name, email});
    mailer_.sendWelcome(email);
}
```

Here the helper pays for itself: sign-up, sign-in, and invitations all clean addresses the same way, and the cleaning
has edge cases worth their own tests. If only one place needed it, a named local would do (1.1).

### 1.3 Few Parameters, No Boolean Flags

Long parameter lists are hard to read at the call site and easy to get in the wrong order.

- **Aim for 0–2 parameters; 3 is fine.** Beyond that, pass a struct with named fields.
- **A `bool` that switches the whole function between two behaviours means two functions:** `writeCsv()` and
  `writeJson()`, not `write(report, true)`.
- **A choice that tweaks a shared body is an `enum class`**, which names itself where it's passed.
- **A bare `bool` only in a private helper**, with `/*name=*/` written at the call.

```cpp
// Avoid: a bare `true` the reader has to look up
exportReport(report, true);

// Prefer, when the two formats share most of the code: an enum that reads at the call
enum class Format { Csv, Json };
exportReport(report, Format::Json);

// Prefer, when they share little: two functions
writeCsv(report, out);
writeJson(report, out);

// Fine: a private helper, with the parameter's name in a comment
copyRows(source, target, /*overwrite=*/true);
```

```cpp
// Avoid: five arguments, two of which are a size and two of which are options
Matrix resample(const Matrix& image, int rows, int cols, double fill, bool keepCorners);

// Prefer: a size and an options struct with defaults
struct Size {
    int rows;
    int cols;
};
struct ResampleOptions {
    double fill = 0.0;
    bool keepCorners = false;
};
Matrix resample(const Matrix& image, Size size, const ResampleOptions& options = {});

// In C++17, name the options on a local
ResampleOptions options;
options.keepCorners = true;
const Matrix thumbnail = resample(image, {64, 64}, options);
// (C++20 designated initializers let the call itself say `{.keepCorners = true}`.)
```

### 1.4 Ask or Do, Not Both (Command-Query Separation)

A query returns data and changes nothing; a command changes state and returns nothing, or a status. Don't hide a
change inside something that reads like a getter. In C++, make queries `const` and the compiler holds you to it.

Two kinds of exception are fine. Some operations exist to act and report in one step: `std::set::insert` tells you
whether the element was new, and a `takeIfReady()` hands back a `std::optional`. And memoising a query is fine, since
callers can't tell; say beside the cache what clears it.

```cpp
// Avoid: looking at the balance settles transfers as a side effect
Money Account::balance() {
    applyPendingTransfers();
    return balance_;
}

// Prefer: the command and the query apart
void Account::settlePending();
Money Account::balance() const;
```

```cpp
// Fine: a cache no caller can observe, cleared where its inputs change
class Invoice {
public:
    Money total() const {
        if (!cachedTotal_) cachedTotal_ = sumOfLines();
        return *cachedTotal_;
    }
    void addLine(Line line) {
        lines_.push_back(std::move(line));
        cachedTotal_.reset();   // every line feeds the total
    }

private:
    Money sumOfLines() const;

    std::vector<Line> lines_;
    mutable std::optional<Money> cachedTotal_;
};
```

## 2. Callers and Callees

Make the wrong call hard to write, rather than relying on every caller to remember a check or an order of calls.

### 2.1 Parse, Don't Validate

Turn raw input into a structured value once, at the edge where it arrives, and have everything further in take that
value. Code past the edge never sees the raw strings or bytes again.

When a guarantee matters ("this is a well-formed address", "these settings were checked"), a `bool` returned by some
`isValid()` is easy to forget. Prefer a type that can only exist once the check has passed: functions that need the
guarantee take that type, so skipping the check doesn't compile.

- **Worth a type of its own** when many functions depend on the guarantee.
- **For a single operation that can fail**, return `std::optional`, or `std::variant<Value, Error>` when the caller
  needs the reason. (C++23 has `std::expected` for exactly this.) Use whatever error style the project already uses.
- **A failure says what would be right**: "timeout must be a whole number of seconds, got 'soon'", not "invalid
  input".

```cpp
// Avoid: a bool that each caller has to remember
bool isValidEmail(std::string_view text);
void subscribe(const std::string& email);   // trusts that someone checked first

// Prefer: the only way to get an EmailAddress is through parse()
class EmailAddress {
public:
    [[nodiscard]] static std::optional<EmailAddress> parse(std::string_view text);
    const std::string& str() const { return value_; }

private:
    explicit EmailAddress(std::string value) : value_(std::move(value)) {}
    std::string value_;
};

void subscribe(const EmailAddress& email);   // the type is the proof: no unchecked text gets here
```

```cpp
// A settings file is read in exactly one place; everything after it takes `const Settings&`
struct Settings {
    std::chrono::seconds timeout;
    int maxRetries;
    std::filesystem::path cacheDir;
};

struct ParseError {
    int line;
    std::string message;   // what's wrong, and what would be right
};

std::variant<Settings, ParseError> parseSettings(std::istream& in);
```

### 2.2 Explicit State and Dependencies

Pass what a function needs as arguments. Don't add mutable globals, singletons, or orderings a caller has to know
("call `init()` before `run()`").

Classes are fine: what an object holds in its members is passed state too. A function that needs many values can take
a struct, or become a member of the class that has them.

```cpp
// Avoid: a global that some other call has to set up first
static const Clock* gClock = nullptr;
void useClock(const Clock& clock) { gClock = &clock; }
bool isExpired(const Token& token) { return token.expiry() < gClock->now(); }   // undefined if nobody called useClock()

// Prefer: the clock is a constructor argument
class TokenChecker {
public:
    explicit TokenChecker(const Clock& clock) : clock_(clock) {}
    bool isExpired(const Token& token) const { return token.expiry() < clock_.now(); }

private:
    const Clock& clock_;
};
```

When something outside your control forces global state (a C library that must be initialised once per process),
confine it to one place and make the precondition visible. A type can carry it: setting up returns a session object,
and whatever needs the library takes the session.

```cpp
class AudioSession {   // the library is usable while one of these is alive
public:
    static std::optional<AudioSession> open();
    AudioSession(AudioSession&& other) noexcept;
    ~AudioSession();
    AudioSession(const AudioSession&) = delete;
    AudioSession& operator=(const AudioSession&) = delete;
};

void playTone(const AudioSession& session, Hertz pitch);   // no session, no call
```

### 2.3 Top-Down Files (The Stepdown Rule)

Order a file like a newspaper article: what the file is for comes first, then the steps it takes, then the small
helpers those use.

- **Inside a file:** public entry points at the top, then their helpers in the order they're called. C++ wants a
  declaration before a use, so declare the helpers at the top of an anonymous namespace and define them further down.
  In a class, the public section comes first.
- **Across files:** when a component spans several files, start the reader in the file that carries its name: the
  entry point, calling into the other files for each stage.

```
MonthlyReport.cpp
│
├── buildMonthlyReport()         what the file is for
│    ├── entriesInMonth()        the steps it calls
│    └── totalByCategory()
│         └── formatAmount()     small helpers last
```

### 2.4 Files Named for What They Do (No Generic Utils)

Grab-bag files (`helpers.h`, `utils.cpp`) gather unrelated code and hide where it belongs.

- **Look for the type it's about.** A free function whose main parameter is an `Order` might be `Order`'s member. But a
  member can see private state: if the function needs only the public interface, a free function in a header named
  for its topic (`Shipping.h`) keeps the class smaller.
- **Shared code gets its own file; local code stays local.** Something several files call, and that makes sense on
  its own, deserves a header named after it. A helper built around one caller's assumptions stays in that caller's
  `.cpp`, in an anonymous namespace, where nobody else picks it up by mistake.
- **Pick file names a reader could guess from the contents.**
- **Split a file when it holds two unrelated responsibilities**, not just because it's long.

```
// Avoid
src/utils.cpp        // date arithmetic, CSV escaping, the retry policy, string helpers

// Prefer
src/DateRange.h      // overlaps, contains, merge
src/CsvWriter.cpp
src/RetryPolicy.h
```

### 2.5 File and Directory Structure

- **Give each component a directory and a build target**; when adding one, start from a sibling's layout.
- **Public headers are the interface, and nothing else is.** Put what other components may include under
  `include/<component>/`, and only that. Implementation files, and headers only the component itself uses, go in
  `src/`; nothing outside reaches into it.
- **A file holds one idea.** Two files called `parser.cpp` in different directories hint that both names are too
  vague.
- **When a file has grown distinct stages**, give it a directory, with a file per stage and the entry point in the one
  named after the component.
- **Dependencies only point down.** Each component lists what it uses, the arrows never loop, and code that seems to
  need an upward include is in the wrong component.

```
inventory/
  CMakeLists.txt                  # add_library(inventory): include/ is public, src/ private
  include/inventory/Inventory.h   # what other components may include
  src/Inventory.cpp
  src/StockLedger.h               # used only inside inventory/
  src/StockLedger.cpp
  test/                           # its unit tests, with a target of their own
```

```
app  ->  services  ->  domain  ->  storage  ->  platform
# each may include only what's to its right: domain/ sees nothing of services/ or app/
```

## 3. Ownership, Lifetime, and Scope

When it's unclear who frees an object, someone frees it twice or nobody does.

### 3.1 Clear Owners, and RAII

- **Ownership stays with the code that made the object.** When that scope ends, the object goes.
- **Don't hand out heap objects without an owner.** Return by value. Return a `std::unique_ptr` when ownership really
  moves, and a `std::shared_ptr` only when it's really shared. Raw pointers and references only borrow: they never
  own, and must not outlive what they point at.
- **Every resource sits inside an object whose destructor releases it**: files, locks, sockets, handles. Never rely on
  each return path remembering a cleanup call.
- **Views borrow too.** A `std::string_view` must not outlive its string. (For arrays, C++20 adds `std::span`; in C++17,
  take a `const std::vector<T>&`, or a pointer and a length.)

```cpp
// Avoid: the caller must guess who frees it
Report* makeReport(const Ledger& ledger) { return new Report(ledger); }

// Prefer: return by value, or hand over a unique_ptr
Report makeReport(const Ledger& ledger);
std::unique_ptr<Exporter> makeExporter(Format format);
```

```cpp
// Avoid: every way out of the function has to close the file by hand
std::optional<std::string> readHeader(const char* path) {
    std::FILE* file = std::fopen(path, "rb");
    if (!file) return std::nullopt;
    char buffer[64];
    if (std::fread(buffer, 1, sizeof buffer, file) != sizeof buffer) {
        std::fclose(file);
        return std::nullopt;
    }
    std::fclose(file);
    return std::string(buffer, sizeof buffer);
}

// Prefer: the handle closes itself, whichever way the function ends
struct FileCloser {
    void operator()(std::FILE* file) const { std::fclose(file); }
};
using FileHandle = std::unique_ptr<std::FILE, FileCloser>;

std::optional<std::string> readHeader(const std::filesystem::path& path) {
    const FileHandle file(std::fopen(path.string().c_str(), "rb"));
    if (!file) return std::nullopt;
    std::string header(64, '\0');
    if (std::fread(header.data(), 1, header.size(), file.get()) != header.size()) return std::nullopt;
    return header;
}
```

(For files alone, `std::ifstream` already closes itself; the custom deleter is the pattern for C APIs that hand out
handles of their own.)

## 4. Comments

Code says *what*; comments say *why*.

- **Delete comments that restate the code** (`// loop over the lines`).
- If a line needs explaining, **first try a better name or an extracted function**.
- **Keep comments for what the code can't say:** a rule from a specification, a constraint, a trade-off, a trap
  (`// not in the constructor: logging isn't up yet`), a local invariant, or a pointer to an outside source.
- **Inline comments are a line or two.**
- **Leave out the story of writing it.** "First we…, then we…", and how you checked it worked, go in the PR.
- **Doc comments (`///` or `/** */`) carry the contract**, on a public function or class and at the top of a file:
  what it's for, what it expects and guarantees, who owns what, units, cost, and the idea of the algorithm when it
  isn't obvious.

```cpp
// Avoid: every line translated into English
// loop over the lines
for (const Line& line : lines) {
    // check whether it is taxable
    if (line.taxable()) {
        // add it to the total
        taxable += line.amount();
    }
}
```

```cpp
// Prefer: a doc comment for the contract and the method; one inline comment for the subtle case

/// Merges overlapping and adjacent date ranges into the fewest ranges that cover the same days.
///
/// Sorts by start, then sweeps once, extending the current range while the next one starts no later than the day
/// after it ends. O(n log n). The input may be in any order; the result is sorted and disjoint.
std::vector<DateRange> mergeRanges(std::vector<DateRange> ranges) {
    std::sort(ranges.begin(), ranges.end(), startsEarlier);
    std::vector<DateRange> merged;
    for (const DateRange& range : ranges) {
        // adjacent ranges merge too: the 1st-3rd and the 4th-6th cover the same days as the 1st-6th
        if (!merged.empty() && range.first() <= merged.back().last().next()) {
            merged.back().extendTo(std::max(merged.back().last(), range.last()));
        } else {
            merged.push_back(range);
        }
    }
    return merged;
}
```

## 5. Names

- **Names say what a value is and why it exists:** `overdueInvoices`, `retryDelay`, `cacheDir`. Avoid `data`, `res`,
  `tmp`, `obj`, `item2`.
- **Name length grows with scope.** `i`, `x`, `it` are fine in a three-line loop or a small lambda. Members, globals,
  and functions are spelled out.
- **No type noise:** `orders`, not `orderVector` or `vOrders`; `title`, not `titleStr`; `Invoice`, not
  `InvoiceClass`.
- **Units in the type, or else in the name:** `std::chrono::milliseconds timeout` beats `int timeoutMs`, which beats
  `int timeout`.
- **Use the domain's words** for domain things: the ones its users and its specifications use.
- **Casing:** follow the project. The examples here use `PascalCase` for types, `camelCase` for functions and
  variables, a trailing `_` for private members, and `kPascalCase` for constants.

```cpp
// Avoid
auto tmp = load(path);
for (auto& x : tmp.v) sum += x.n;

// Prefer
const Ledger ledger = loadLedger(path);
for (const Entry& entry : ledger.entries()) balance += entry.amount();
```

## 6. Flat Control Flow

- **Handle bad input and edge cases first** with guard clauses, then return. The happy path runs unindented to the end.
- **Invert conditions to bail out early**, rather than wrapping the main path in `if { … } else`.
- **Aim for at most two levels of nesting** inside a function. Deeper usually means a function wants to come out.

```cpp
// Avoid
std::optional<Shipment> planShipment(const Order& order, const Warehouse& warehouse) {
    if (order.isPaid()) {
        if (!order.lines().empty()) {
            if (warehouse.canFulfil(order)) {
                return warehouse.pack(order);
            }
        }
    }
    return std::nullopt;
}

// Prefer
std::optional<Shipment> planShipment(const Order& order, const Warehouse& warehouse) {
    if (!order.isPaid()) return std::nullopt;
    if (order.lines().empty()) return std::nullopt;
    if (!warehouse.canFulfil(order)) return std::nullopt;
    return warehouse.pack(order);
}
```

## 7. Design Documentation

Code shows what was built, not what was decided or why. Write the decisions down next to the code, so the next person
(or agent) doesn't undo them by accident.

- **One file's design:** a comment heading that file.
- **Ideas several files share:** a short guide beside that code, linked from the repository's `AGENTS.md` so agents
  find it.
- **Keep them true.** They describe the design as it is now, with the numbers you watch (latency, memory, build time)
  and their budgets, and the PR that changes the behaviour updates them.

```cpp
// RateLimiter.cpp: holds each client to a steady request rate, allowing short bursts.
//
// Approach: one token bucket per client, topped up lazily from the time since its last request, so idle clients cost
// nothing. Rejected: a sliding log of request times, which costs memory per request; a bucket is two numbers.
// Always true: a bucket holds between zero and `burst` tokens.
```

## 8. Hot Paths

Code that runs millions of times (an inner loop, a parser's core, a per-pixel or per-packet step) may trade tidiness
for speed: a flat loop over contiguous data can beat a neat abstraction. That's acceptable when:

- a comment says why, and
- a benchmark shows the gain, kept with the code so the next change can be measured too.

Everywhere else, readability wins.

## 9. Writing

In docs, comments, and text users see:

- **Use the serial (Oxford) comma** in lists of three or more: "files, sockets, and locks", not "files, sockets and
  locks". The same goes for "or". Two items take no comma.
- **Plain words for users.** Spell an abbreviation out the first time it appears, and prefer the everyday word to the
  internal one.
- **Names users see follow one capitalisation rule**, written down once and applied where the text is shown; data keeps
  the case its source gave it.
