# Vendored data

`functions.csv` is copied from https://github.com/ad-si/Woxi , release 0.4.0 . It is not modified.

The engine reads only the `name` and `rank` columns: the rank is Woxi's own ordering of how fundamental each symbol is (rank 1 `List`, 2 `Rule`, 3 `Times`, ..., 21 `Plot`, 22 `Sin`), which the completion list uses as a prior so frequent names come first and rare ones stay out of the way. Descriptions, status and the rest arrive at run time through the interpreter's public API, so this copy only has to be refreshed when the symbol registry changes.
