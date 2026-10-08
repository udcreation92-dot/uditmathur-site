import datetime


def build_pos_file(portfolios: list[list[dict]], acct_id: str = "TEST") -> str:
    """Build a PC-SPAN .pos (v4.00) XML file, one <portfolio> per entry in `portfolios`,
    firm numbered 1..N in the given order so results can be matched back positionally
    once the .pos is run through PC-SPAN and the output Results.csv is re-imported.

    `acct_id` is stamped on every portfolio and comes back verbatim in Results.csv's
    Portfolio column ("{firm} - {acctId} - ..."), so callers can pass a unique run token
    to verify an imported Results.csv actually corresponds to *this* export rather than
    a stale file left over from an earlier run.

    Each leg dict: {pf_code, expiry (YYYYMMDD str), option_type ("C"/"P"), strike, net (signed qty)}.
    """
    today = datetime.date.today().strftime("%Y%m%d")
    lines = [
        '<?xml version="1.0" encoding="utf-8"?>',
        "<posFile>",
        "  <fileFormat>4.00</fileFormat>",
        f"  <created>{today}</created>",
        "  <pointInTime>",
        f"    <date>{today}</date>",
        "    <isSetl>1</isSetl>",
    ]
    for i, legs in enumerate(portfolios, start=1):
        lines += [
            "    <portfolio>",
            f"      <firm>{i}</firm>",
            f"      <acctId>{acct_id}</acctId>",
            "      <acctType>S</acctType>",
            "      <isCust>1</isCust>",
            "      <seg>CUST</seg>",
            "      <isNew>1</isNew>",
            "      <currency>INR</currency>",
            "      <ledgerBal>0</ledgerBal>",
            "      <ote>0</ote>",
            "      <securities>0</securities>",
            "      <lue>0</lue>",
            "      <ecPort>",
            "        <ec>NSCCL</ec>",
        ]
        for leg in legs:
            strike = leg["strike"]
            strike_str = str(int(strike)) if float(strike).is_integer() else str(strike)
            lines += [
                "        <np>",
                "          <exch>NSE</exch>",
                f"          <pfCode>{leg['pf_code']}</pfCode>",
                "          <pfType>OOP</pfType>",
                f"          <pe>{leg['expiry']}</pe>",
                "          <undPe>00000000</undPe>",
                f"          <o>{leg['option_type']}</o>",
                f"          <k>{strike_str}</k>",
                f"          <net>{leg['net']}</net>",
                "        </np>",
            ]
        lines += ["      </ecPort>", "    </portfolio>"]
    lines += ["  </pointInTime>", "</posFile>"]
    return "\n".join(lines)
