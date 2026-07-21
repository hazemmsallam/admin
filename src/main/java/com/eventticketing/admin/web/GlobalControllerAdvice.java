package com.eventticketing.admin.web;

import com.eventticketing.admin.client.TicketingApiException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.ControllerAdvice;
import org.springframework.web.bind.annotation.ExceptionHandler;

/**
 * Renders a friendly error page when a page-loading request fails — either the ticketing API
 * returned an error, or it couldn't be reached at all. (Form POST actions catch errors locally
 * so they can re-render the form.)
 */
@ControllerAdvice
public class GlobalControllerAdvice {

    private static final Logger log = LoggerFactory.getLogger(GlobalControllerAdvice.class);

    @ExceptionHandler(TicketingApiException.class)
    public String handleApiError(TicketingApiException ex, Model model) {
        model.addAttribute("errorTitle", "The ticketing API returned an error");
        model.addAttribute("errorMessage", ex.getMessage());
        return "error";
    }

    @ExceptionHandler(Exception.class)
    public String handleGenericError(Exception ex, Model model) {
        log.error("Unexpected error", ex);
        model.addAttribute("errorTitle", "Could not reach the ticketing API");
        model.addAttribute("errorMessage",
                "Check that event-ticketing is running and that ticketing.base-url points to it. (" + ex.getMessage() + ")");
        return "error";
    }
}
