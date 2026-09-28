"""Label vocabularies with a deterministic train/test split (disjoint labels)."""

import zlib

BUTTONS = """Sign in|Subscribe|Checkout|Add to cart|Download|Continue|Save changes|Delete|Export|Share|Next
|Previous|Settings|Profile|Help|Contact|Pricing|Blog|Docs|Log in|Register|Apply|Book now|Learn more|Get started
|View details|Compare|Upload|Submit|Archive|Refresh|Filter|Sort|Edit|Copy link|Invite|Upgrade|Billing
|Notifications|Messages|Calendar|Reports|Analytics|Team|Projects|Tasks|Files|Support|Feedback|Privacy|Terms
|Careers|About us|News|Events|Shop|Deals|Wishlist|Orders|Returns|Track order|Gift cards|Stores|Dashboard
|Integrations|Security|API keys|Changelog|Status|Community|Forum|Webinars|Templates|Plugins|Themes|Library
|Favorites|History|Downloads|Account|Payments|Invoices|Plans|Checkout now|Reserve|Donate|Join now|Try free
|Start trial|Watch demo|Request quote|Schedule call|Open ticket|Chat with us|Explore|Discover|Browse all
|See more|Show all|Load more|Print|Duplicate|Rename|Move|Publish|Preview|Approve|Reject|Assign|Merge|Deploy
|Run tests|Rebuild|Sync now|Connect|Disconnect|Import|Backup|Restore|Verify|Confirm order|Pay now|Redeem
|Follow|Unfollow|Like|Comment|Reply|Bookmark|Report issue|Mute|Pin|Tag people|Go live|Record|Stop sharing""".replace(
    "\n", ""
).split("|")

FIELDS = """Email|Full name|City|Phone|Company|Search|Username|Password|Zip code|Coupon code|Address|Title|Message
|First name|Last name|Country|Website|Job title|Department|Promo code|Card holder|Nickname|Street|State|Budget
|Quantity|Guest count|Order number|Project name|Team name|Invite code|Referral|Twitter handle|Bio|Subject
|Destination|Departure|Check-in|Flight number|Tracking ID""".replace("\n", "").split("|")

VALUES = """alice@example.com|bob.smith@mail.test|Paris|Berlin|+1 415 555 0134|Acme Corp|wireless headphones
|jdoe42|hunter2pass|94107|SAVE20|221B Baker Street|Senior Engineer|Hello there|Maria|Lopez|Canada|acme.io
|Designer|Finance|SPRING24|Chen Wei|mo|Main St 5|Texas|4500|12|7|A-99812|Apollo|Night Owls|ZX-81|friend01
|@gnsis|Coffee lover|Invoice question|Tokyo|Lisbon|2026-10-12|LH 440|TRK77812|carol@corp.test|Oslo
|standing desk|42|grace@lab.test|Nairobi|VIP-7|Quarterly review|dan_k|Lima|running shoes|+44 20 7946 0958""".replace(
    "\n", ""
).split("|")

SITES = """Northwind|Acme|Globex|Initech|Umbrella|Hooli|Stark|Wayne|Soylent|Tyrell|Cyberdyne|Wonka|Vandelay
|Pied Piper|Aperture|Oscorp|Massive|Blue Sun|Monarch|Gringotts""".replace("\n", "").split("|")

WORDS = [
    "quick",
    "brown",
    "fox",
    "lorem",
    "ipsum",
    "dolor",
    "amet",
    "consectetur",
    "adipiscing",
    "elit",
    "sed",
    "tempor",
    "incididunt",
    "labore",
    "dolore",
    "magna",
    "aliqua",
    "enim",
    "minim",
    "veniam",
    "quis",
    "nostrud",
    "exercitation",
    "ullamco",
    "laboris",
    "nisi",
    "aliquip",
    "commodo",
    "consequat",
    "duis",
    "aute",
    "irure",
    "reprehenderit",
    "voluptate",
    "velit",
    "esse",
    "cillum",
    "fugiat",
    "nulla",
    "pariatur",
    "excepteur",
    "sint",
    "occaecat",
    "cupidatat",
    "proident",
    "sunt",
    "culpa",
    "officia",
    "deserunt",
    "mollit",
    "anim",
]


def is_test(label: str) -> bool:
    return zlib.crc32(label.encode()) % 4 == 0


def split(items: list[str], test: bool) -> list[str]:
    return [x for x in items if is_test(x) == test]
