"""Migrate saved Terrarium image references after the GHCR publisher move."""

import re


def terrarium_image_publisher(image):
    """Keep custom images and pinned content intact; move only our two mirrors."""
    return re.sub(
        r"^ghcr\.io/terion-name/(?=terrarium-dhi-(?:oauth2-proxy|postgres)(?:[:@]|$))",
        "ghcr.io/terion-labs/",
        image,
    )


class FilterModule:
    def filters(self):
        return {"terrarium_image_publisher": terrarium_image_publisher}
