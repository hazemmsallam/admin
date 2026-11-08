package com.eventticketing.admin.web.form;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import lombok.Data;

@Data
public class EventForm {

    @NotBlank
    private String name;

    private String description;

    private String category;

    /** URL of the poster image shown on event cards and the event detail hero. */
    @Size(max = 500)
    private String imageUrl;

    /** Short line above the title on the detail page (e.g. "BETWEEN TWO SEAS"). */
    @Size(max = 200)
    private String tagline;

    /** Shown with a Featured badge on the customer list. */
    private boolean featured;

    /** Comma-separated tags typed by the operator; parsed to a Set when calling the API. */
    private String tags;

    /** Value from an HTML datetime-local input, e.g. "2026-08-01T19:00". Treated as UTC. */
    @NotBlank
    private String startAt;

    @NotBlank
    private String endAt;

    @NotNull
    private Long organizerId;

    @NotNull
    private Long hallId;
}
